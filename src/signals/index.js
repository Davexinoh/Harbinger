import fetch from "node-fetch";

const BINANCE = "https://api.binance.com/api/v3";

function clamp(v) { return Math.max(0, Math.min(1, v)); }
function sigmoid(x, k = 2) { return 1 / (1 + Math.exp(-k * x)); }

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  const ag = g / period, al = l / period;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

async function binanceKlines(symbol, interval, limit) {
  const res = await fetch(`${BINANCE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!res.ok) throw new Error(`Binance ${res.status}`);
  return res.json();
}

async function binanceTicker(symbols) {
  const q   = encodeURIComponent(JSON.stringify(symbols));
  const res = await fetch(`${BINANCE}/ticker/24hr?symbols=${q}`);
  if (!res.ok) throw new Error(`Binance ticker ${res.status}`);
  return res.json();
}

// ─── 1. Crypto momentum — multi-timeframe consensus ───────────────────────────
async function cryptoSignal() {
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  const tickers = await binanceTicker(symbols);

  const klineResults = await Promise.all(
    symbols.map(s => binanceKlines(s, "1h", 3).catch(() => null))
  );

  let bullVotes = 0, bearVotes = 0;

  tickers.forEach((t, i) => {
    const chg24  = parseFloat(t.priceChangePercent) || 0;
    const klines = klineResults[i];
    const chg1h  = klines
      ? (parseFloat(klines[2]?.[4]) - parseFloat(klines[0]?.[4])) / parseFloat(klines[0]?.[4]) * 100
      : 0;

    if (chg1h > 0.05 && chg24 > 0) bullVotes++;
    else if (chg1h < -0.05 && chg24 < 0) bearVotes++;
  });

  const direction = bullVotes >= bearVotes ? "UP" : "DOWN";
  const score     = clamp(0.5 + (bullVotes - bearVotes) / symbols.length * 0.35);

  return {
    score,
    direction,
    label: `Crypto ${bullVotes}↑/${bearVotes}↓`,
  };
}

// ─── 2. BTC 15m — RSI zones + momentum + volume ───────────────────────────────
async function btc15mSignal() {
  const klines = await binanceKlines("BTCUSDT", "15m", 30);
  const closes = klines.map(k => parseFloat(k[4]));
  const vols   = klines.map(k => parseFloat(k[5]));

  const r     = rsi(closes, 14);
  const last  = closes[closes.length - 1];
  const prev5 = closes[closes.length - 5];
  const chg5  = (last - prev5) / prev5 * 100;

  const avgVol = vols.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const volOk  = vols[vols.length - 1] > avgVol * 0.8;

  let score, direction;

  if (r < 35 && chg5 > 0) {
    score     = clamp(0.72 + (35 - r) / 200);
    direction = "UP";
  } else if (r > 65 && chg5 < 0) {
    score     = clamp(0.28 - (r - 65) / 200);
    direction = "DOWN";
  } else {
    score     = clamp(sigmoid(chg5 * 1.2));
    direction = chg5 >= 0 ? "UP" : "DOWN";
  }

  if (!volOk) score = clamp(score * 0.88 + 0.5 * 0.12);

  return {
    score,
    direction,
    label: `BTC15m RSI:${r.toFixed(0)} 5c:${chg5.toFixed(2)}%`,
  };
}

// ─── 3. Sentiment — weighted RSS ─────────────────────────────────────────────
const RSS_FEEDS = [
  { url: "https://coindesk.com/arc/outboundfeeds/rss/",   weight: 2.0 },
  { url: "https://cointelegraph.com/rss",                  weight: 2.0 },
  { url: "https://nairametrics.com/feed/",                 weight: 1.5 },
  { url: "https://feeds.bbci.co.uk/sport/africa/rss.xml", weight: 1.0 },
];

const POS_WORDS = ["surge","gain","rise","bull","rally","breakout","growth","record","beat","win","positive","pump","recover","bounce"];
const NEG_WORDS = ["crash","drop","fall","bear","loss","fail","miss","dump","negative","plunge","risk","warn","concern","hack","fraud"];

async function sentimentSignal() {
  let wPos = 0, wNeg = 0, wTotal = 0;

  await Promise.all(RSS_FEEDS.map(async ({ url, weight }) => {
    try {
      const res    = await fetch(url, { signal: AbortSignal.timeout(4000) });
      const txt    = await res.text();
      const titles = [...txt.matchAll(/<title>(.*?)<\/title>/gi)].map(m => m[1].toLowerCase());
      for (const t of titles) {
        const p = POS_WORDS.filter(w => t.includes(w)).length;
        const n = NEG_WORDS.filter(w => t.includes(w)).length;
        if (p > n) wPos += weight;
        else if (n > p) wNeg += weight;
        wTotal += weight;
      }
    } catch {}
  }));

  if (wTotal === 0) return { score: 0.5, direction: null, label: "No feeds" };
  const score = clamp(0.5 + (wPos - wNeg) / (wTotal * 2));
  return {
    score,
    direction: score > 0.52 ? "UP" : score < 0.48 ? "DOWN" : null,
    label: `Sentiment ${wPos.toFixed(0)}pos/${wNeg.toFixed(0)}neg`,
  };
}

// ─── 4. Market pressure — Bayse order flow ───────────────────────────────────
async function marketPressureSignal(pubKey) {
  if (!pubKey) return { score: 0.5, direction: null, label: "No key" };
  try {
    const res = await fetch(
      `https://relay.bayse.markets/v1/pm/events?category=crypto&status=open&size=20&currency=NGN`,
      { headers: { "X-Public-Key": pubKey } }
    );
    if (!res.ok) return { score: 0.5, direction: null, label: "Bayse fallback" };

    const data   = await res.json();
    const events = (data?.events || []).filter(e =>
      e.engine !== "AMM" && e.markets?.some(m => m.status === "open")
    );

    if (!events.length) return { score: 0.5, direction: null, label: "No markets" };

    let totalYes = 0, count = 0;
    for (const e of events.slice(0, 10)) {
      const m = e.markets?.find(mk => mk.status === "open");
      if (!m) continue;
      totalYes += m.outcome1Price || 0.5;
      count++;
    }

    if (!count) return { score: 0.5, direction: null, label: "No data" };

    const avgYes  = totalYes / count;
    const score   = clamp(0.3 + avgYes * 0.5);
    return {
      score,
      direction: avgYes > 0.52 ? "UP" : avgYes < 0.48 ? "DOWN" : null,
      label: `Pressure YES avg:${(avgYes * 100).toFixed(0)}%`,
    };
  } catch (err) {
    return { score: 0.5, direction: null, label: "Pressure error" };
  }
}

// ─── Composite ────────────────────────────────────────────────────────────────
const WEIGHTS = {
  crypto:    0.35,
  btc15m:    0.30,
  sentiment: 0.15,
  pressure:  0.20,
};

export async function runAllSignals(pubKey) {
  const neutral = { score: 0.5, direction: null, label: "error" };

  const [crypto, btc15m, sentiment, pressure] = await Promise.all([
    cryptoSignal().catch(() => neutral),
    btc15mSignal().catch(() => neutral),
    sentimentSignal().catch(() => neutral),
    marketPressureSignal(pubKey).catch(() => neutral),
  ]);

  // Pure weighted composite — no agreement penalty dragging to neutral
  const composite = clamp(
    crypto.score    * WEIGHTS.crypto    +
    btc15m.score    * WEIGHTS.btc15m    +
    sentiment.score * WEIGHTS.sentiment +
    pressure.score  * WEIGHTS.pressure
  );

  // Direction by vote
  const all       = [crypto, btc15m, sentiment, pressure];
  const upVotes   = all.filter(s => ["UP","YES"].includes(s.direction?.toUpperCase())).length;
  const downVotes = all.filter(s => ["DOWN","NO"].includes(s.direction?.toUpperCase())).length;
  const direction = upVotes >= downVotes ? "UP" : "DOWN";
  const agreement = Math.max(upVotes, downVotes);

  console.log(
    `[Signals] crypto:${crypto.score.toFixed(2)} btc15m:${btc15m.score.toFixed(2)} ` +
    `sentiment:${sentiment.score.toFixed(2)} pressure:${pressure.score.toFixed(2)} ` +
    `→ composite:${composite.toFixed(2)} dir:${direction} agree:${agreement}/4`
  );

  return { crypto, btc15m, sentiment, pressure, composite, direction, agreement };
}
export { btc15mSignal as runBTC15mSignal };
