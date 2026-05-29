import "dotenv/config";
import fs from "fs";

const STATE_FILE = "state.json";
const EQUITY_FILE = "equity.json";
const SYMBOLS_FILE = "symbols.json";

// =========================
// STATE SYSTEM
// =========================
function load(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

function save(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function retry(fn, n = 3, delay = 800) {
  for (let i = 0; i < n; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === n - 1) throw e;
      await sleep(delay);
    }
  }
}

// =========================
// HEDGE FUND RISK ENGINE
// =========================
function equityCheck() {
  const eq = load(EQUITY_FILE, { start: 1000, current: 1000 });
  const dd = ((eq.current - eq.start) / eq.start) * 100;
  return dd > -5;
}

function adaptiveRisk(state) {
  const base = Number(process.env.RISK || 0.01);

  // win streak scaling (institutional behavior)
  if (state.winStreak >= 3) return base * 1.5;
  if (state.winStreak >= 5) return base * 2;

  // loss protection
  if (state.lossStreak >= 2) return base * 0.5;

  return base;
}

// =========================
// LIQUIDITY SWEEP FILTER (SIMPLIFIED SMC)
// =========================
function liquiditySweepFilter(signal) {
  // expects signal.liquiditySweep = true from strategy layer
  if (signal.liquiditySweep === false) return false;
}
