import "dotenv/config";
import fs from "fs";
import crypto from "crypto";

const CONFIG = {
  symbol:        process.env.SYMBOL             || "BTCUSDT",
  timeframe:     "15min",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "100"),
  riskPerTrade:  parseFloat(process.env.RISK_PER_TRADE       || "0.005"),
  rrRatio:       2.0,
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY   || "3"),
  maxDailyLoss:  parseFloat(process.env.MAX_DAILY_LOSS       || "0.05"),
  maxDrawdown:   parseFloat(process.env.MAX_DRAWDOWN         || "0.10"),
  orbStartUTC:   13 * 60 + 30,
  orbEndUTC:     13 * 60 + 45,
  tradeStartUTC: 13 * 60 + 45,
  tradeEndUTC:   21 * 60,
  paperTrading:  process.env.PAPER_TRADING !== "false",
  bitget: {
    apiKey:     process.env.BITGET_API_KEY     || "",
    secretKey:  process.env.BITGET_SECRET_KEY  || "",
    passphrase: process.env.BITGET_PASSPHRASE  || "",
    baseUrl:    process.env.BITGET_BASE_URL    || "https://api.bitget.com",
  },
};

const STATE_FILE = "state.json";

function loadState() {
  const today = new Date().toISOString().slice(0, 10);
  if (!fs.existsSync(STATE_FILE)) return { date: today, tradesToday: 0, dailyPnL: 0, peakValue: CONFIG.portfolioValue, openPosition: false };
  const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  if (s.date !== today) return { date: today, tradesToday: 0, dailyPnL: 0, peakValue: s.peakValue || CONFIG.portfolioValue, openPosition: false };
  return s;
}

function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

const CSV_FILE = "trades.csv";
const CSV_HEADER = "Date,Time,Symbol,Side,Entry,SL,TP,Qty,RR,Risk$,Mode,OrderId,Notes";

function initCsv() {
  if (!fs.existsSync(CSV_FILE)) { fs.writeFileSync(CSV_FILE, CSV_HEADER + "\n"); }
}

function logTrade(t) {
  const d = new Date(t.timestamp);
  const row = [d.toISOString().slice(0,10), d.toISOString().slice(11,19), t.symbol, t.side,
    t.entry?.toFixed(2)??"", t.stopLoss?.toFixed(2)??"", t.takeProfit?.toFixed(2)??"",
    t.qty?.toFixed(6)??"", t.rr?.toFixed(1)??"", t.riskUSD?.toFixed(2)??"",
    t.mode, t.orderId??"", `"${t.notes??""}"`,
  ].join(",");
  fs.appendFileSync(CSV_FILE, row + "\n");
  console.log("📝 Trade logged → " + CSV_FILE);
}

async function fetchCandles(symbol, interval, limit = 300) {
  const url = `${CONFIG.bitget.baseUrl}/api/v2/spot/market/candles?symbol=${symbol}&granularity=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("BitGet candles error: " + res.status);
  const json = await res.json();
  return (json.data || []).map(k => ({ time: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) }));
}

function calcVWAP(candles) {
  const todayStart = new Date(); todayStart.setUTCHours(0,0,0,0);
  const src = candles.filter(c => c.time >= todayStart.getTime());
  const data = src.length > 0 ? src : candles;
  let tpv = 0, vol = 0;
  data.forEach(c => { const tp = (c.high + c.low + c.close) / 3; tpv += tp * c.volume; vol += c.volume; });
  return vol === 0 ? null : tpv / vol;
}

function calcORB(candles) {
  const orb = candles.filter(c => { const m = Math.floor(c.time / 60000) % 1440; return m >= CONFIG.orbStartUTC && m < CONFIG.orbEndUTC; });
  if (orb.length === 0) return { orbHigh: null, orbLow: null };
  return { orbHigh: Math.max(...orb.map(c => c.high)), orbLow: Math.min(...orb.map(c => c.low)) };
}

function signBitGet(ts, method, path, body = "") {
  return crypto.createHmac("sha256", CONFIG.bitget.secretKey).update(`${ts}${method}${path}${body}`).digest("base64");
}

async function placeOrder(side, qty) {
  const ts = Date.now().toString();
  const path = "/api/v2/spot/trade/placeOrder";
  const body = JSON.stringify({ symbol: CONFIG.symbol, side, orderType: "market", quantity: qty.toFixed(6), force: "gtc" });
  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "ACCESS-KEY": CONFIG.bitget.apiKey, "ACCESS-SIGN": signBitGet(ts, "POST", path, body), "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase },
    body,
  });
  const data = await res.json();
  if (data.code !== "00000") throw new Error("BitGet: " + data.msg);
  return data.data;
}

async function run() {
  initCsv();
  const state = loadState();
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const totalMin = utcH * 60 + utcM;
  const isWeekend = [0, 6].includes(now.getUTCDay());

  console.log("\n═══════════════════════════════════════════════");
  console.log("  ORB + VWAP Bot — FundedNext Compliant");
  console.log("  " + now.toISOString());
  console.log("  Mode: " + (CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"));
  console.log("  Symbol: " + CONFIG.symbol + " | Portfolio: $" + CONFIG.portfolioValue);
  console.log("  Trades today: " + state.tradesToday + "/" + CONFIG.maxTradesPerDay);
  console.log("  Daily P&L: " + (state.dailyPnL * 100).toFixed(2) + "%");
  console.log("═══════════════════════════════════════════════\n");

  if (isWeekend) { console.log("📅 Weekend — no trading (FundedNext rule)"); return; }
  if (totalMin < CONFIG.orbStartUTC || totalMin > CONFIG.tradeEndUTC) { console.log("⏰ Outside trading window — exiting"); return; }
  if (state.dailyPnL <= -CONFIG.maxDailyLoss) { console.log("🛑 Daily loss limit hit — stopping"); return; }
  if (state.tradesToday >= CONFIG.maxTradesPerDay) { console.log("🚫 Max trades/day reached"); return; }
  if (state.openPosition) { console.log("🚫 Position already open"); return; }

  console.log("── Fetching market data ────────────────────────\n");
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 300);
  const price = candles.at(-1).close;
  const prev = candles.at(-2)?.close ?? price;
  const vwap = calcVWAP(candles);
  const { orbHigh, orbLow } = calcORB(candles);

  console.log("  Price:    $" + price.toFixed(2));
  console.log("  VWAP:     $" + (vwap?.toFixed(2) ?? "N/A"));
  console.log("  ORB High: $" + (orbHigh?.toFixed(2) ?? "Not formed"));
  console.log("  ORB Low:  $" + (orbLow?.toFixed(2) ?? "Not formed"));

  if (!orbHigh || !orbLow) { console.log("\n⏳ ORB not formed yet"); return; }
  if (totalMin < CONFIG.tradeStartUTC) { console.log("\n⏳ Waiting for ORB to complete (9:45 NY)"); return; }

  const orbRange = orbHigh - orbLow;
  if (orbRange < price * 0.001) { console.log("\n⚠️  ORB range too small — skipping"); return; }

  console.log("\n── Signal Check ────────────────────────────────\n");
  const brokeAboveORB = prev <= orbHigh && price > orbHigh;
  const aboveVWAP = vwap ? price > vwap : false;

  console.log("  Broke above ORB: " + (brokeAboveORB ? "✅" : "🚫"));
  console.log("  Above VWAP:      " + (aboveVWAP ? "✅" : "🚫"));

  if (!brokeAboveORB || !aboveVWAP) { console.log("\n⏳ No signal — waiting"); return; }

  const riskUSD = CONFIG.portfolioValue * CONFIG.riskPerTrade;
  const stopDistance = price - orbLow;
  const takeProfit = price + stopDistance * CONFIG.rrRatio;
  const qty = riskUSD / stopDistance;

  console.log("\n✅ SIGNAL CONFIRMED — LONG");
  console.log("   Entry:  $" + price.toFixed(2));
  console.log("   SL:     $" + orbLow.toFixed(2));
  console.log("   TP:     $" + takeProfit.toFixed(2));
  console.log("   Risk:   $" + riskUSD.toFixed(2) + " (0.5%)");
  console.log("   Qty:    " + qty.toFixed(6));

  const trade = { timestamp: now.toISOString(), symbol: CONFIG.symbol, side: "buy", entry: price, stopLoss: orbLow, takeProfit, qty, rr: CONFIG.rrRatio, riskUSD, mode: CONFIG.paperTrading ? "PAPER" : "LIVE", orderId: null, notes: "" };

  if (CONFIG.paperTrading) {
    console.log("\n📋 PAPER TRADE — BUY $" + (qty * price).toFixed(2));
    trade.orderId = "PAPER-" + Date.now();
    trade.notes = "ORB + VWAP confirmed";
  } else {
    try {
      const order = await placeOrder("buy", qty);
      trade.orderId = order.orderId;
      trade.notes = "ORB + VWAP confirmed";
      console.log("✅ ORDER PLACED — " + order.orderId);
    } catch (err) {
      console.log("❌ ORDER FAILED — " + err.message);
      trade.notes = "Error: " + err.message;
    }
  }

  logTrade(trade);
  state.openPosition = true;
  state.tradesToday += 1;
  saveState(state);
  console.log("\n═══════════════════════════════════════════════\n");
}

run().catch(err => { console.error("❌ Bot error:", err.message); process.exit(1); });