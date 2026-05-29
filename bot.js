import "dotenv/config";
import fetch from "node-fetch";
import fs from "fs";

// ─────────── ACCOUNT CONFIG ───────────
const ACCOUNT = {
  balance: parseFloat(process.env.ACCOUNT_BALANCE || "6000"),
  riskPercent: parseFloat(process.env.RISK_PERCENT || "0.5"),
  maxDailyLossPercent: 4.5,   // stops BEFORE FundedNext 5% limit
  maxTotalLossPercent: 9.5,   // stops BEFORE FundedNext 10% limit
  maxTradesPerDay: 3,
  maxLossesPerDay: 2,
  rewardRatio: parseFloat(process.env.REWARD_RATIO || "2"),
};

const EXCHANGE = process.env.EXCHANGE || "binance"; // "binance" or "bitget"
const SYMBOL   = process.env.SYMBOL   || "BTCUSDT";
const PAPER    = process.env.PAPER_TRADING !== "false";

const BINANCE_BASE = "https://api.binance.com";
const BITGET_BASE  = "https://api.bitget.com";

// ─────────── STATE (persists daily stats) ───────────
const STATE_FILE  = "state.json";
const TRADES_FILE = "trades.json";

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const today = new Date().toISOString().slice(0, 10);
    if (s.date !== today) {
      return { date: today, trades: 0, losses: 0, dailyPnL: 0,
               totalPnL: s.totalPnL || 0 };
    }
    return s;
  } catch {
    return { date: new Date().toISOString().slice(0,10),
             trades: 0, losses: 0, dailyPnL: 0, totalPnL: 0 };
  }
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function saveTrade(t) {
  let trades = [];
  try { trades = JSON.parse(fs.readFileSync(TRADES_FILE,"utf8")); } catch {}
  trades.push(t);
  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ─────────── SESSION FILTER ───────────
function isTradingSession() {
  const h = new Date().getUTCHours();
  const m = new Date().getUTCMinutes();
  const t = h + m / 60;
  const london  = t >= 8  && t < 11;   // 8:00–11:00 UTC
  const newYork = t >= 13 && t < 17;   // 13:00–17:00 UTC
  if (!london && !newYork) {
    log(`❌ Outside sessions (UTC ${h}:${String(m).padStart(2,"0")}). London 8-11, NY 13-17.`);
    return false;
  }
  log(`✅ Session: ${london ? "London" : "New York"}`);
  return true;
}

// ─────────── NEWS FILTER ───────────
async function isHighImpactNews() {
  try {
    const h = new Date().getUTCHours();
    const m = new Date().getUTCMinutes();
    const now = h * 60 + m;
    // Block 30 min before & 30 min after known news times (UTC)
    const newsTimes = [
      { h: 13, m: 30 },  // NFP / CPI / most US data
      { h: 18, m: 0  },  // FOMC
      { h: 19, m: 0  },  // FOMC alternate
    ];
    for (const nt of newsTimes) {
      const center = nt.h * 60 + nt.m;
      if (now >= center - 30 && now <= center + 30) {
        log(`⚠️  High-impact news window — skipping.`);
        return true;
      }
    }
    return false;
  } catch { return false; }
}

// ─────────── RISK GUARD ───────────
function passesRiskGuard(state) {
  const dailyLimit = ACCOUNT.balance * (ACCOUNT.maxDailyLossPercent / 100);
  const totalLimit = ACCOUNT.balance * (ACCOUNT.maxTotalLossPercent / 100);

  if (state.trades >= ACCOUNT.maxTradesPerDay) {
    log(`🛑 Max trades/day reached (${state.trades}). Done for today.`); return false; }
  if (state.losses >= ACCOUNT.maxLossesPerDay) {
    log(`🛑 Max losses/day reached (${state.losses}). Done for today.`); return false; }
  if (state.dailyPnL <= -dailyLimit) {
    log(`🛑 Daily loss limit hit: $${Math.abs(state.dailyPnL).toFixed(2)} / $${dailyLimit.toFixed(2)}`); return false; }
  if (state.totalPnL <= -totalLimit) {
    log(`🛑 MAX DRAWDOWN HIT: $${Math.abs(state.totalPnL).toFixed(2)} / $${totalLimit.toFixed(2)} — STOP ALL TRADING`); return false; }

  return true;
}

// ─────────── MARKET DATA ───────────
async function getKlines(limit = 50) {
  if (EXCHANGE === "bitget") {
    const url = `${BITGET_BASE}/api/v2/spot/market/candles?symbol=${SYMBOL}&granularity=15min&limit=${limit}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.data.map(k => ({
      open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5]
    }));
  } else {
    const url = `${BINANCE_BASE}/api/v3/klines?symbol=${SYMBOL}&interval=15m&limit=${limit}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.map(k => ({
      open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5]
    }));
  }
}

async function getPrice() {
  if (EXCHANGE === "bitget") {
    const url = `${BITGET_BASE}/api/v2/spot/market/tickers?symbol=${SYMBOL}`;
    const res = await fetch(url);
    const data = await res.json();
    return +data.data[0].lastPr;
  } else {
    const url = `${BINANCE_BASE}/api/v3/ticker/price?symbol=${SYMBOL}`;
    const res = await fetch(url);
    const data = await res.json();
    return +data.price;
  }
}

// ─────────── INDICATORS ───────────
function calcVWAP(candles) {
  let tpv = 0, vol = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    tpv += tp * c.volume;
    vol += c.volume;
  }
  return vol === 0 ? 0 : tpv / vol;
}

function calcORB(candles, n = 2) {
  const orb = candles.slice(0, n);
  return {
    high: Math.max(...orb.map(c => c.high)),
    low:  Math.min(...orb.map(c => c.low)),
  };
}

// ─────────── POSITION SIZING ───────────
function calcSize(entry, stop) {
  const riskUSD  = ACCOUNT.balance * (ACCOUNT.riskPercent / 100); // $30
  const riskPerUnit = Math.abs(entry - stop);
  return riskPerUnit === 0 ? 0 : riskUSD / riskPerUnit;
}

// ─────────── MAIN STRATEGY ───────────
async function run() {
  log("═══════════════════════════════════════════");
  log(`💼 FundedNext Bot | Balance: $${ACCOUNT.balance}`);
  log(`⚡ Risk: ${ACCOUNT.riskPercent}% = $${(ACCOUNT.balance * ACCOUNT.riskPercent / 100).toFixed(2)}/trade`);
  log(`🔴 Daily limit: $${(ACCOUNT.balance * ACCOUNT.maxDailyLossPercent / 100).toFixed(2)} | Total limit: $${(ACCOUNT.balance * ACCOUNT.maxTotalLossPercent / 100).toFixed(2)}`);

  // Checks
  if (!isTradingSession()) return;
  if (await isHighImpactNews()) return;

  const state = loadState();
  log(`📊 Today: ${state.trades} trades | ${state.losses} losses | Daily P&L: $${state.dailyPnL.toFixed(2)} | Total P&L: $${state.totalPnL.toFixed(2)}`);
  if (!passesRiskGuard(state)) return;

  // Market data
  const [candles, price] = await Promise.all([getKlines(50), getPrice()]);
  const orb  = calcORB(candles, 2);
  const vwap = calcVWAP(candles);

  log(`💹 ${SYMBOL} | Price: $${price} | ORB H: $${orb.high.toFixed(2)} | ORB L: $${orb.low.toFixed(2)} | VWAP: $${vwap.toFixed(2)}`);

  // Signal
  let signal = null;
  if (price > orb.high && price > vwap) signal = "LONG";
  else if (price < orb.low  && price < vwap)  signal = "SHORT";

  if (!signal) { log("⏳ No signal — inside ORB. Waiting."); return; }

  // Trade levels
  const stop   = signal === "LONG" ? orb.low : orb.high;
  const risk   = Math.abs(price - stop);
  const target = signal === "LONG" ? price + risk * ACCOUNT.rewardRatio
                                   : price - risk * ACCOUNT.rewardRatio;
  const size     = calcSize(price, stop);
  const riskUSD  = ACCOUNT.balance * ACCOUNT.riskPercent / 100;
  const profitUSD = riskUSD * ACCOUNT.rewardRatio;

  log(`🎯 ═══ ${signal} SIGNAL ═══`);
  log(`   Entry:          $${price.toFixed(2)}`);
  log(`   Stop Loss:      $${stop.toFixed(2)}`);
  log(`   Take Profit:    $${target.toFixed(2)}`);
  log(`   Position Size:  ${size.toFixed(6)} ${SYMBOL}`);
  log(`   Risk:           $${riskUSD.toFixed(2)} (${ACCOUNT.riskPercent}%)`);
  log(`   Potential Gain: $${profitUSD.toFixed(2)} (${(ACCOUNT.riskPercent * ACCOUNT.rewardRatio).toFixed(1)}%)`);
  log(`   RR:             1:${ACCOUNT.rewardRatio}`);
  log(`   Mode:           ${PAPER ? "PAPER 📝" : "LIVE 🚀"}`);

  // Update state
  state.trades += 1;
  saveState(state);

  // Log trade
  saveTrade({
    time: new Date().toISOString(),
    exchange: EXCHANGE,
    symbol: SYMBOL,
    signal,
    entry: price,
    stop: +stop.toFixed(2),
    target: +target.toFixed(2),
    size: +size.toFixed(6),
    riskUSD: +riskUSD.toFixed(2),
    potentialProfitUSD: +profitUSD.toFixed(2),
    rr: `1:${ACCOUNT.rewardRatio}`,
    paper: PAPER,
    balance: ACCOUNT.balance,
  });

  log("✅ Trade logged.");
}

run().catch(err => {
  log(`💥 ERROR: ${err.message}`);
  process.exit(1);
});
