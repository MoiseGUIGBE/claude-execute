// =====================================================
// FUNDEDNEXT / PROP FIRM SAFE BOT
// ORB + VWAP Strategy
// Exchange: Binance / Bitget
// Timeframe: 15m
// Node.js 18+
// =====================================================

import "dotenv/config";
import fs from "fs";

// =====================================================
// ACCOUNT CONFIG
// =====================================================

const ACCOUNT = {
  balance: parseFloat(process.env.ACCOUNT_BALANCE || "6000"),
  riskPercent: parseFloat(process.env.RISK_PERCENT || "0.5"),

  // FundedNext Safety Limits
  maxDailyLossPercent: 4.5,
  maxTotalLossPercent: 9.5,

  maxTradesPerDay: 3,
  maxLossesPerDay: 2,

  rewardRatio: parseFloat(process.env.REWARD_RATIO || "2"),
};

const EXCHANGE = process.env.EXCHANGE || "binance";
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const PAPER = process.env.PAPER_TRADING !== "false";

// =====================================================
// API URLS
// =====================================================

const BINANCE_BASE = "https://api.binance.com";
const BITGET_BASE = "https://api.bitget.com";

// =====================================================
// FILES
// =====================================================

const STATE_FILE = "state.json";
const TRADES_FILE = "trades.json";

// =====================================================
// HELPERS
// =====================================================

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function safeNumber(n) {
  return Number.isFinite(n) ? n : 0;
}

// =====================================================
// LOAD / SAVE STATE
// =====================================================

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));

    const today = new Date().toISOString().slice(0, 10);

    if (s.date !== today) {
      return {
        date: today,
        trades: 0,
        losses: 0,
        dailyPnL: 0,
        totalPnL: s.totalPnL || 0,
      };
    }

    return s;
  } catch {
    return {
      date: new Date().toISOString().slice(0, 10),
      trades: 0,
      losses: 0,
      dailyPnL: 0,
      totalPnL: 0,
    };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function saveTrade(trade) {
  let trades = [];

  try {
    trades = JSON.parse(fs.readFileSync(TRADES_FILE, "utf8"));
  } catch {}

  trades.push(trade);

  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
}

// =====================================================
// SESSION FILTER
// =====================================================

function isTradingSession() {
  const now = new Date();

  const h = now.getUTCHours();
  const m = now.getUTCMinutes();

  const t = h + m / 60;

  const london = t >= 8 && t < 11;
  const newYork = t >= 13 && t < 17;

  if (!london && !newYork) {
    log(
      `❌ Outside sessions | UTC ${h}:${String(m).padStart(
        2,
        "0"
      )} | London 8-11 | NY 13-17`
    );

    return false;
  }

  log(`✅ Trading Session: ${london ? "London" : "New York"}`);

  return true;
}

// =====================================================
// NEWS FILTER
// =====================================================

async function isHighImpactNews() {
  try {
    const now = new Date();

    const h = now.getUTCHours();
    const m = now.getUTCMinutes();

    const current = h * 60 + m;

    const newsTimes = [
      { h: 13, m: 30 }, // CPI / NFP
      { h: 18, m: 0 }, // FOMC
      { h: 19, m: 0 },
    ];

    for (const news of newsTimes) {
      const center = news.h * 60 + news.m;

      if (current >= center - 30 && current <= center + 30) {
        log("⚠️ High-impact news window — skipping.");
        return true;
      }
    }

    return false;
  } catch (err) {
    log(`News Filter Error: ${err.message}`);
    return false;
  }
}

// =====================================================
// RISK GUARD
// =====================================================

function passesRiskGuard(state) {
  const dailyLimit =
    ACCOUNT.balance * (ACCOUNT.maxDailyLossPercent / 100);

  const totalLimit =
    ACCOUNT.balance * (ACCOUNT.maxTotalLossPercent / 100);

  if (state.trades >= ACCOUNT.maxTradesPerDay) {
    log(`🛑 Max trades/day reached.`);
    return false;
  }

  if (state.losses >= ACCOUNT.maxLossesPerDay) {
    log(`🛑 Max losses/day reached.`);
    return false;
  }

  if (state.dailyPnL <= -dailyLimit) {
    log(`🛑 Daily drawdown limit reached.`);
    return false;
  }

  if (state.totalPnL <= -totalLimit) {
    log(`🛑 Total drawdown limit reached.`);
    return false;
  }

  return true;
}

// =====================================================
// MARKET DATA
// =====================================================

async function getKlines(limit = 50) {
  try {
    if (EXCHANGE === "bitget") {
      const url = `${BITGET_BASE}/api/v2/spot/market/candles?symbol=${SYMBOL}&granularity=15min&limit=${limit}`;

      const res = await fetch(url);

      const json = await res.json();

      if (!json.data) throw new Error("Invalid Bitget response");

      return json.data.map((k) => ({
        open: safeNumber(+k[1]),
        high: safeNumber(+k[2]),
        low: safeNumber(+k[3]),
        close: safeNumber(+k[4]),
        volume: safeNumber(+k[5]),
      }));
    }

    // BINANCE

    const url = `${BINANCE_BASE}/api/v3/klines?symbol=${SYMBOL}&interval=15m&limit=${limit}`;

    const res = await fetch(url);

    const json = await res.json();

    if (!Array.isArray(json)) {
      throw new Error("Invalid Binance response");
    }

    return json.map((k) => ({
      open: safeNumber(+k[1]),
      high: safeNumber(+k[2]),
      low: safeNumber(+k[3]),
      close: safeNumber(+k[4]),
      volume: safeNumber(+k[5]),
    }));
  } catch (err) {
    log(`❌ Klines Error: ${err.message}`);
    return [];
  }
}

async function getPrice() {
  try {
    if (EXCHANGE === "bitget") {
      const url = `${BITGET_BASE}/api/v2/spot/market/tickers?symbol=${SYMBOL}`;

      const res = await fetch(url);

      const json = await res.json();

      return safeNumber(+json.data[0].lastPr);
    }

    const url = `${BINANCE_BASE}/api/v3/ticker/price?symbol=${SYMBOL}`;

    const res = await fetch(url);

    const json = await res.json();

    return safeNumber(+json.price);
  } catch (err) {
    log(`❌ Price Error: ${err.message}`);
    return 0;
  }
}

// =====================================================
// INDICATORS
// =====================================================

function calcVWAP(candles) {
  let totalTPV = 0;
  let totalVolume = 0;

  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;

    totalTPV += tp * c.volume;
    totalVolume += c.volume;
  }

  return totalVolume === 0 ? 0 : totalTPV / totalVolume;
}

function calcORB(candles, bars = 4) {
  const orbCandles = candles.slice(0, bars);

  return {
    high: Math.max(...orbCandles.map((c) => c.high)),
    low: Math.min(...orbCandles.map((c) => c.low)),
  };
}

// =====================================================
// POSITION SIZE
// =====================================================

function calcPositionSize(entry, stop) {
  const riskUSD =
    ACCOUNT.balance * (ACCOUNT.riskPercent / 100);

  const riskPerUnit = Math.abs(entry - stop);

  if (riskPerUnit <= 0) return 0;

  return riskUSD / riskPerUnit;
}

// =====================================================
// STRATEGY
// =====================================================

async function run() {
  try {
    log("═══════════════════════════════════");
    log(`💼 FundedNext Bot Started`);
    log(`💰 Balance: $${ACCOUNT.balance}`);
    log(
      `⚡ Risk: ${ACCOUNT.riskPercent}% = $${
        (ACCOUNT.balance * ACCOUNT.riskPercent) / 100
      }`
    );

    // SESSION CHECK

    if (!isTradingSession()) return;

    // NEWS FILTER

    if (await isHighImpactNews()) return;

    // STATE

    const state = loadState();

    log(
      `📊 Trades: ${state.trades} | Losses: ${state.losses} | DailyPnL: ${state.dailyPnL}`
    );

    if (!passesRiskGuard(state)) return;

    // GET DATA

    const [candles, price] = await Promise.all([
      getKlines(50),
      getPrice(),
    ]);

    if (!candles.length || !price) {
      log("❌ No market data.");
      return;
    }

    // INDICATORS

    const orb = calcORB(candles, 4);
    const vwap = calcVWAP(candles);

    log(
      `📈 ${SYMBOL} | Price: ${price.toFixed(
        2
      )} | ORB High: ${orb.high.toFixed(
        2
      )} | ORB Low: ${orb.low.toFixed(
        2
      )} | VWAP: ${vwap.toFixed(2)}`
    );

    // SIGNAL

    let signal = null;

    if (price > orb.high && price > vwap) {
      signal = "LONG";
    } else if (price < orb.low && price < vwap) {
      signal = "SHORT";
    }

    if (!signal) {
      log("⏳ No valid setup.");
      return;
    }

    // TRADE LEVELS

    const stop =
      signal === "LONG" ? orb.low : orb.high;

    const risk = Math.abs(price - stop);

    const target =
      signal === "LONG"
        ? price + risk * ACCOUNT.rewardRatio
        : price - risk * ACCOUNT.rewardRatio;

    const size = calcPositionSize(price, stop);

    const riskUSD =
      ACCOUNT.balance * (ACCOUNT.riskPercent / 100);

    const rewardUSD =
      riskUSD * ACCOUNT.rewardRatio;

    // LOG SIGNAL

    log("════════ SIGNAL ════════");
    log(`📍 Direction: ${signal}`);
    log(`🎯 Entry: ${price.toFixed(2)}`);
    log(`🛑 Stop: ${stop.toFixed(2)}`);
    log(`💰 Target: ${target.toFixed(2)}`);
    log(`📦 Size: ${size.toFixed(6)}`);
    log(`⚖️ RR: 1:${ACCOUNT.rewardRatio}`);
    log(`📝 Mode: ${PAPER ? "PAPER" : "LIVE"}`);
    log(`💵 Risk: $${riskUSD.toFixed(2)}`);
    log(`🏆 Reward: $${rewardUSD.toFixed(2)}`);

    // UPDATE STATE

    state.trades += 1;

    saveState(state);

    // SAVE TRADE

    saveTrade({
      time: new Date().toISOString(),
      exchange: EXCHANGE,
      symbol: SYMBOL,
      signal,
      entry: price,
      stop,
      target,
      size,
      riskUSD,
      rewardUSD,
      paper: PAPER,
    });

    log("✅ Trade logged successfully.");
  } catch (err) {
    log(`💥 BOT ERROR: ${err.message}`);
  }
}

// =====================================================
// START BOT
// =====================================================

run();
