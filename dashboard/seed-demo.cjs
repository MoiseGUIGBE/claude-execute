// Demo data seeder for the Claude Execute dashboard.
//
//   node dashboard/seed-demo.cjs        # populate
//   node dashboard/seed-demo.cjs reset  # remove demo data
//
// Generates 12 plausible safety-check decisions over the past ~2 days.
// Hand-picked indicator regimes — most recent decision is a BLOCK (typical),
// three PASS trades earlier in the window so the feed and the trades panel
// both have content. All trades use the PAPER- prefix so they're obviously
// not real orders.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const LOG_PATH = path.join(ROOT, "safety-check-log.json");
const CSV_PATH = path.join(ROOT, "trades.csv");

const SYMBOL = "BTCUSDT";
const TIMEFRAME = "4H";
const PORTFOLIO = 1000;
const MAX_TRADE = 50;
const MAX_PER_DAY = 3;
const TRADE_SIZE = Math.min(PORTFOLIO * 0.01, MAX_TRADE); // $10

if (process.argv[2] === "reset") {
  if (fs.existsSync(LOG_PATH)) fs.unlinkSync(LOG_PATH);
  // Reset trades.csv to header-only
  const header = "Date,Time (UTC),Exchange,Symbol,Side,Quantity,Price,Total USD,Fee (est.),Net Amount,Order ID,Mode,Notes\n";
  fs.writeFileSync(CSV_PATH, header);
  console.log("✓ Demo data cleared.");
  process.exit(0);
}

// hours ago, price, ema8, vwap, rsi3
const scenarios = [
  [0.5, 63190, 63350, 63220, 38.0],
  [2,   63440, 63320, 63140, 47.2],
  [4,   63290, 63010, 62880, 24.1],
  [7,   63110, 63040, 62830, 58.4],
  [11,  62980, 62700, 62450, 19.6],
  [15,  62540, 62380, 62150, 32.4],
  [19,  62380, 62620, 62810, 73.1],
  [24,  62520, 62880, 63040, 28.0],
  [28,  61730, 62100, 61980, 41.0],
  [33,  61890, 61610, 61410, 22.8],
  [38,  62210, 62050, 61750, 64.5],
  [44,  61240, 61480, 61320, 52.0],
];

const now = Date.now();
const trades = scenarios.map(([h, price, ema8, vwap, rsi3], i) => {
  const ts = new Date(now - h * 3600 * 1000).toISOString();
  const conditions = [
    {
      label: "Price is above VWAP — buyers in control for the session",
      pass: price > vwap,
      actual: price,
      threshold: vwap,
    },
    {
      label: "Price is above EMA(8) — uptrend confirmed",
      pass: price > ema8,
      actual: price,
      threshold: ema8,
    },
    {
      label: "RSI(3) has dropped below 30 — short-term pullback in an uptrend, snap-back likely",
      pass: rsi3 < 30,
      actual: rsi3,
      threshold: 30,
    },
  ];
  const allPass = conditions.every((c) => c.pass);

  // tradesToday counter: count prior PASS-and-placed entries that share calendar day
  return {
    timestamp: ts,
    symbol: SYMBOL,
    timeframe: TIMEFRAME,
    price,
    indicators: { ema8, vwap, rsi3 },
    conditions,
    allPass,
    tradeSize: TRADE_SIZE,
    orderPlaced: allPass,
    orderId: allPass ? `PAPER-${new Date(ts).getTime()}` : null,
    paperTrading: true,
    limits: {
      maxTradeSizeUSD: MAX_TRADE,
      maxTradesPerDay: MAX_PER_DAY,
      tradesToday: 0, // filled below
    },
  };
});

// chronological order for tradesToday calculation, then preserved
const chrono = [...trades].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
const dailyCount = {};
for (const t of chrono) {
  const day = t.timestamp.slice(0, 10);
  if (t.orderPlaced) {
    dailyCount[day] = (dailyCount[day] || 0) + 1;
  }
  t.limits.tradesToday = dailyCount[day] || 0;
}

// Bot persists trades in chronological order (push order)
fs.writeFileSync(LOG_PATH, JSON.stringify({ trades: chrono }, null, 2));

// Mirror the executed trades into trades.csv (matches bot's writeTradeCsv)
const header = "Date,Time (UTC),Exchange,Symbol,Side,Quantity,Price,Total USD,Fee (est.),Net Amount,Order ID,Mode,Notes\n";
const rows = chrono.map((t) => {
  const d = new Date(t.timestamp);
  const date = d.toISOString().slice(0, 10);
  const time = d.toISOString().slice(11, 19);
  const side = t.orderPlaced ? "buy" : "—";
  const qty = t.orderPlaced ? (t.tradeSize / t.price).toFixed(8) : "0";
  const total = t.orderPlaced ? t.tradeSize.toFixed(2) : "0";
  const fee = t.orderPlaced ? (t.tradeSize * 0.001).toFixed(4) : "0";
  const net = t.orderPlaced ? (t.tradeSize - t.tradeSize * 0.001).toFixed(4) : "0";
  const orderId = t.orderId || "BLOCKED";
  const mode = "PAPER";
  let notes;
  if (t.orderPlaced) {
    notes = "All conditions met";
  } else {
    const failed = t.conditions.filter((c) => !c.pass).map((c) => c.label.split(" — ")[0]);
    notes = `Failed: ${failed.join("; ")}`;
  }
  return [
    date, time, "BitGet", t.symbol, side, qty, t.price.toFixed(2), total, fee, net, orderId, mode, `"${notes}"`,
  ].join(",");
});
fs.writeFileSync(CSV_PATH, header + rows.join("\n") + "\n");

const passes = chrono.filter((t) => t.allPass).length;
const blocks = chrono.length - passes;

console.log(`✓ Seeded ${chrono.length} demo decisions:`);
console.log(`  - ${passes} PASS  (paper trades placed)`);
console.log(`  - ${blocks} BLOCK (safety check rejected)`);
console.log(`  - safety-check-log.json  (${chrono.length} entries)`);
console.log(`  - trades.csv             (${chrono.length} rows)`);
console.log(``);
console.log(`To clear demo data:  node dashboard/seed-demo.cjs reset`);
