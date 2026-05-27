import "dotenv/config";
import fs from "fs";
import crypto from "crypto";

// ───────────────── CONFIG ─────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  entryTF: "15m",
  htfTF: "4h",

  paperTrading: process.env.PAPER_TRADING !== "false",

  riskPerTrade: parseFloat(process.env.RISK_PER_TRADE || "0.005"),  // 0.5%
  maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS || "0.03"),   // 3%
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  maxConsecutiveLosses: parseInt(process.env.MAX_CONSECUTIVE_LOSSES || "3"),

  atrSLMultiplier: 1.5,
  atrTPMultiplier: 3.0,

  minATRPercent: 0.35,

  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "10000"),

  sessions: {
    london: [7, 11],
    ny: [13, 17],
  },

  bitget: {
    apiKey: process.env.BITGET_API_KEY || "",
    secretKey: process.env.BITGET_SECRET_KEY || "",
    passphrase: process.env.BITGET_PASSPHRASE || "",
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

// ───────────────── STATE / DAILY RESET ─────────────────

const STATE_FILE = "state.json";

function loadState() {
  const today = new Date().toISOString().slice(0, 10);

  if (!fs.existsSync(STATE_FILE)) {
    return {
      date: today,
      tradesToday: 0,
      dailyPnL: 0,
      consecutiveLosses: 0,
      openPosition: false,
    };
  }

  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));

  // Reset daily counters if it's a new day
  if (state.date !== today) {
    console.log(`📅 New day detected (${today}) — resetting daily counters`);
    return {
      date: today,
      tradesToday: 0,
      dailyPnL: 0,
      consecutiveLosses: state.consecutiveLosses, // carry over streak
      openPosition: false,
    };
  }

  return state;
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ───────────────── CSV LOGGING ─────────────────

const CSV_FILE = "trades.csv";
const CSV_HEADERS = [
  "Date", "Time (UTC)", "Symbol", "Side", "Entry",
  "SL", "TP", "Qty", "RR", "ATR", "Mode", "OrderId", "Notes"
].join(",");

function initCsv() {
  if (!fs.existsSync(CSV_FILE)) {
    fs.writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
    console.log(`📄 Created ${CSV_FILE}`);
  }
}

function logTrade(entry) {
  const now = new Date(entry.timestamp);
  const row = [
    now.toISOString().slice(0, 10),
    now.toISOString().slice(11, 19),
    entry.symbol,
    entry.side,
    entry.price?.toFixed(2) ?? "",
    entry.stopLoss?.toFixed(2) ?? "",
    entry.takeProfit?.toFixed(2) ?? "",
    entry.qty?.toFixed(6) ?? "",
    entry.rr?.toFixed(2) ?? "",
    entry.atr?.toFixed(4) ?? "",
    entry.mode,
    entry.orderId ?? "",
    `"${entry.notes ?? ""}"`,
  ].join(",");

  fs.appendFileSync(CSV_FILE, row + "\n");
  console.log(`📝 Trade logged → ${CSV_FILE}`);
}

// ───────────────── SESSION FILTER ─────────────────

function nowUTC() {
  return new Date().getUTCHours();
}

function inTradingSession() {
  const h = nowUTC();
  const { london, ny } = CONFIG.sessions;
  return (h >= london[0] && h <= london[1]) || (h >= ny[0] && h <= ny[1]);
}

// ───────────────── MARKET DATA ─────────────────

async function fetchCandles(symbol, interval, limit = 200) {
  const url =
    `${CONFIG.bitget.baseUrl}/api/v2/spot/market/candles` +
    `?symbol=${symbol}&granularity=${interval}&limit=${limit}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`BitGet API error: ${res.status}`);
  const json = await res.json();

  return json.data.map((k) => ({
    time: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

// ───────────────── INDICATORS ─────────────────

function ema(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let value = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    value = data[i] * k + value * (1 - k);
  }
  return value;
}

function rsi(data, period = 14) {
  if (data.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = data.length - period; i < data.length; i++) {
    const diff = data[i] - data[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function vwap(candles) {
  let tpv = 0, volume = 0;
  candles.forEach((c) => {
    const tp = (c.high + c.low + c.close) / 3;
    tpv += tp * c.volume;
    volume += c.volume;
  });
  return volume === 0 ? null : tpv / volume;
}

// ───────────────── SMART MONEY FILTERS ─────────────────

function bullishDisplacement(candles) {
  const last = candles.at(-1);
  return (last.close - last.open) / last.open > 0.004;
}

function bearishDisplacement(candles) {
  const last = candles.at(-1);
  return (last.open - last.close) / last.open > 0.004;
}

function volumeSpike(candles) {
  const last = candles.at(-1).volume;
  const avg = candles.slice(-20).reduce((a, b) => a + b.volume, 0) / 20;
  return last > avg * 1.5;
}

function liquiditySweepLow(candles) {
  const last = candles.at(-1);
  const prevLow = Math.min(...candles.slice(-10, -1).map((c) => c.low));
  return last.low < prevLow && last.close > prevLow;
}

function liquiditySweepHigh(candles) {
  const last = candles.at(-1);
  const prevHigh = Math.max(...candles.slice(-10, -1).map((c) => c.high));
  return last.high > prevHigh && last.close < prevHigh;
}

// ───────────────── RISK ENGINE ─────────────────

function calculateQty(portfolioValue, riskPercent, stopDistance) {
  if (stopDistance <= 0) return 0;
  return (portfolioValue * riskPercent) / stopDistance;
}

function canTrade(state) {
  if (state.openPosition) {
    console.log("🚫 Open position exists — skipping");
    return false;
  }
  if (state.tradesToday >= CONFIG.maxTradesPerDay) {
    console.log(`🚫 Max trades/day reached: ${state.tradesToday}/${CONFIG.maxTradesPerDay}`);
    return false;
  }
  if (state.dailyPnL <= -CONFIG.maxDailyLoss) {
    console.log(`🚫 Daily loss limit hit: ${(state.dailyPnL * 100).toFixed(2)}%`);
    return false;
  }
  if (state.consecutiveLosses >= CONFIG.maxConsecutiveLosses) {
    console.log(`🚫 Consecutive losses: ${state.consecutiveLosses} — cooling off`);
    return false;
  }
  return true;
}

// ───────────────── BITGET EXECUTION ─────────────────

function sign(timestamp, method, path, body = "") {
  return crypto
    .createHmac("sha256", CONFIG.bitget.secretKey)
    .update(`${timestamp}${method}${path}${body}`)
    .digest("base64");
}

async function placeOrder(side, qty) {
  const timestamp = Date.now().toString();
  const path = "/api/v2/spot/trade/placeOrder";

  const body = JSON.stringify({
    symbol: CONFIG.symbol,
    side: side,           // "buy" or "sell"
    orderType: "market",
    quantity: qty.toFixed(6),
    force: "gtc",
  });

  const signature = sign(timestamp, "POST", path, body);

  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });

  const data = await res.json();

  if (data.code !== "00000") {
    throw new Error(`BitGet order failed: ${data.msg}`);
  }

  return data.data;
}

// ───────────────── SIGNAL EVALUATION ─────────────────

function evaluateSignals({ price, ema20, ema50, htfEMA50, htfPrice, VWAP, rsi3, ATR, atrPercent, candles }) {
  const htfBullish = htfPrice > htfEMA50;
  const htfBearish = htfPrice < htfEMA50;

  const longSignal =
    htfBullish &&
    price > ema20 &&
    price > ema50 &&
    price > VWAP &&
    rsi3 < 30 &&
    atrPercent > CONFIG.minATRPercent &&
    liquiditySweepLow(candles) &&
    bullishDisplacement(candles) &&
    volumeSpike(candles);

  const shortSignal =
    htfBearish &&
    price < ema20 &&
    price < ema50 &&
    price < VWAP &&
    rsi3 > 70 &&
    atrPercent > CONFIG.minATRPercent &&
    liquiditySweepHigh(candles) &&
    bearishDisplacement(candles) &&
    volumeSpike(candles);

  return { longSignal, shortSignal };
}

// ───────────────── MAIN ─────────────────

async function run() {
  initCsv();
  const state = loadState();

  console.log("\n═══════════════════════════════════════════════════");
  console.log("  Institutional Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER" : "🔴 LIVE"}`);
  console.log(`  Symbol: ${CONFIG.symbol}`);
  console.log("═══════════════════════════════════════════════════\n");

  // Session filter
  if (!inTradingSession()) {
    const h = nowUTC();
    console.log(`⏰ Outside London/NY session (UTC hour: ${h}) — exiting`);
    return;
  }
  console.log(`✅ In trading session (UTC hour: ${nowUTC()})`);

  // Risk gate
  if (!canTrade(state)) return;

  // Fetch candles
  console.log("\n── Fetching market data ───────────────────────────\n");
  const [htfCandles, candles] = await Promise.all([
    fetchCandles(CONFIG.symbol, CONFIG.htfTF, 200),
    fetchCandles(CONFIG.symbol, CONFIG.entryTF, 200),
  ]);

  const closes = candles.map((c) => c.close);
  const htfCloses = htfCandles.map((c) => c.close);

  const price = closes.at(-1);
  const htfPrice = htfCloses.at(-1);

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const htfEMA50 = ema(htfCloses, 50);
  const rsi3 = rsi(closes, 3);
  const ATR = atr(candles);
  const VWAP = vwap(candles);

  if (!ema20 || !ema50 || !htfEMA50 || !rsi3 || !ATR || !VWAP) {
    console.log("⚠️  Not enough data for indicators — exiting");
    return;
  }

  const atrPercent = (ATR / price) * 100;

  console.log(`  Price:     $${price.toFixed(2)}`);
  console.log(`  EMA20:     $${ema20.toFixed(2)}`);
  console.log(`  EMA50:     $${ema50.toFixed(2)}`);
  console.log(`  HTF EMA50: $${htfEMA50.toFixed(2)}`);
  console.log(`  VWAP:      $${VWAP.toFixed(2)}`);
  console.log(`  RSI(3):    ${rsi3.toFixed(2)}`);
  console.log(`  ATR:       $${ATR.toFixed(4)} (${atrPercent.toFixed(2)}%)`);

  // Evaluate signals
  const { longSignal, shortSignal } = evaluateSignals({
    price, ema20, ema50, htfEMA50, htfPrice, VWAP, rsi3, ATR, atrPercent, candles,
  });

  console.log("\n── Signal ─────────────────────────────────────────\n");

  if (!longSignal && !shortSignal) {
    console.log("⏳ No valid setup — conditions not met");
    return;
  }

  const side = longSignal ? "buy" : "sell";
  const stopDistance = ATR * CONFIG.atrSLMultiplier;
  const tpDistance = ATR * CONFIG.atrTPMultiplier;

  const stopLoss = side === "buy"
    ? price - stopDistance
    : price + stopDistance;

  const takeProfit = side === "buy"
    ? price + tpDistance
    : price - tpDistance;

  const rr = tpDistance / stopDistance;
  const qty = calculateQty(CONFIG.portfolioValue, CONFIG.riskPerTrade, stopDistance);

  console.log(`✅ ${side.toUpperCase()} SIGNAL CONFIRMED`);
  console.log(`   Entry:  $${price.toFixed(2)}`);
  console.log(`   SL:     $${stopLoss.toFixed(2)}`);
  console.log(`   TP:     $${takeProfit.toFixed(2)}`);
  console.log(`   RR:     ${rr.toFixed(2)}`);
  console.log(`   Qty:    ${qty.toFixed(6)}`);

  // Execute
  const tradeEntry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.symbol,
    side,
    price,
    stopLoss,
    takeProfit,
    qty,
    rr,
    atr: ATR,
    mode: CONFIG.paperTrading ? "PAPER" : "LIVE",
    orderId: null,
    notes: "",
  };

  if (CONFIG.paperTrading) {
    console.log(`\n📋 PAPER TRADE — ${side.toUpperCase()} $${(qty * price).toFixed(2)} of ${CONFIG.symbol}`);
    tradeEntry.orderId = `PAPER-${Date.now()}`;
    tradeEntry.notes = "All conditions met";
  } else {
    console.log(`\n🔴 PLACING LIVE ORDER...`);
    try {
      const order = await placeOrder(side, qty);
      tradeEntry.orderId = order.orderId;
      tradeEntry.notes = "All conditions met";
      console.log(`✅ ORDER PLACED — ${order.orderId}`);
    } catch (err) {
      console.log(`❌ ORDER FAILED — ${err.message}`);
      tradeEntry.notes = `Error: ${err.message}`;
    }
  }

  // Log trade
  logTrade(tradeEntry);

  // Update state
  state.openPosition = true;
  state.tradesToday += 1;
  saveState(state);

  console.log("\n═══════════════════════════════════════════════════\n");
}

run().catch((err) => {
  console.error("❌ Bot error:", err);
  process.exit(1);
});
