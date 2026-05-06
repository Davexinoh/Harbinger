// Central signal runner — all four sources, composite score
// Each signal returns { score: 0-1, direction: "UP"|"DOWN"|null, label, error? }
// On any failure, returns neutral 0.5 — never crashes the composite

import fetch from "node-fetch";

const BINANCE = "https://api.binance.com/api/v3";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function clamp(v)  { return Math.max(0, Math.min(1, v)); }
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

async function binanceTicker(symbols) {
  const q   = encodeURIComponent(JSON.stringify(symbols));
  const res = await fetch(`${BINANCE}/ticker/24hr?symbols=${q}`);
  if (!res.ok) throw new Error(`Binance ticker ${res.status}`);
  return res.json();
}

async function binanceKlines(symbol, interval, limit) {
  const res = await fetch(`${BINANCE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!res.ok) throw new Error(`Binance klines ${res.status}`);
  return res.json();
}

// ─── 1. Crypto signal ─────────────────────────────────────────────────────────
async function cryptoSignal() {
  const symbols  = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
  const tickers  = await binanceTicker(symbols);

  const scored = tickers.map(t => {
    const chg24 = parseFloat(t.priceChangePercent) || 0;
    const score = clamp(sigmoid(chg24 / 3));
    return { symbol: t.symbol, score, chg24, direction: chg24 > 0 ? "UP" : "DOWN" };
  });

  const best = scored.reduce((a, b) => a.score > b.score ? a : b);
  return { score: best.score, direction: best.direction, label: `${best.symbol} ${best.chg24 > 0 ? "+" : ""}${best.chg24.toFixed(2)}%`, all: scored };
}

// ─── 2. BTC 15-min signal ─────────────────────────────────────────────────────
async function btc15mSignal() {
  const klines = await binanceKlines("BTCUSDT", "15m", 20);
  const closes = klines.map(k => parseFloat(k[4]));
  const vols   = klines.map(k => parseFloat(k[5]));

  const r       = rsi(closes);
  const last    = closes[closes.length - 1];
  const prev    = closes[closes.length - 2];
  const chg     = (last - prev) / prev * 100;
  const avgVol  = vols.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const volRat  = vols[vols.length - 1] / avgVol;

  const mScore  = clamp(sigmoid(chg * 1.5));
  const rsiScore = r > 70 ? 0.35 : r < 30 ? 0.65 : clamp(r / 100);
  const score    = clamp(mScore * 0.6 + rsiScore * 0.3 + Math.min(volRat / 3, 1) * 0.1);
  const direction = chg > 0 && r < 70 ? "UP" : "DOWN";

  return { score, direction, label: `BTC15m RSI:${r.toFixed(0)} chg:${chg.toFixed(2)}%` };
}

// ─── 3. Sentiment signal ──────────────────────────────────────────────────────
const RSS_FEEDS = [
  "https://feeds.bbci.co.uk/sport/africa/rss.xml",
  "https://coindesk.com/arc/outboundfeeds/rss/",
  "https://nairametrics.com/feed/",
];

const POS = ["win","surge","gain","rise","bull","up","growth","positive","high","beat","record"];
const NEG = ["loss","drop","fall","bear","down","crash","negative","low","fail","miss","debt"];

async function sentimentSignal() {
  let posCount = 0, negCount = 0, total = 0;

  await Promise.all(RSS_FEEDS.map(async url => {
    try {
      const res = await fetch(url, { timeout: 5000 });
      const txt = await res.text();
      const titles = [...txt.matchAll(/<title>(.*?)<\/title>/gi)].map(m => m[1].toLowerCase());
      for (const t of titles) {
        total++;
        const p = POS.filter(w => t.includes(w)).length;
        const n = NEG.filter(w => t.includes(w)).length;
        if (p > n) posCount++;
        else if (n > p) negCount++;
      }
    } catch {}
  }));

  if (total === 0) return { score: 0.5, direction: null, label: "No feeds" };
  const score = clamp(0.5 + (posCount - negCount) / (total * 2));
  return { score, direction: score > 0.5 ? "UP" : "DOWN", label: `${posCount}pos/${negCount}neg of ${total}` };
}

// ─── 4. Sports signal ─────────────────────────────────────────────────────────
async function sportsSignal(pubKey) {
  // Fetch open sports events from Bayse directly — score by activity
  const res = await fetch(`https://relay.bayse.markets/v1/pm/events?category=sports&status=open&size=20&currency=NGN`, {
    headers: pubKey ? { "X-Public-Key": pubKey } : {},
  });
  if (!res.ok) return { score: 0.5, direction: "YES", label: "Sports fallback" };
  const data = await res.json();
  const events = data?.events || [];
  if (!events.length) return { score: 0.5, direction: "YES", label: "No sports events" };

  const best = events
    .filter(e => e.markets?.some(m => m.status === "open"))
    .sort((a, b) => (b.totalOrders || 0) - (a.totalOrders || 0))[0];

  if (!best) return { score: 0.5, direction: "YES", label: "No active sports" };

  const market = best.markets.find(m => m.status === "open");
  const price  = market?.outcome1Price || 0.5;
  // Score reflects how "certain" the market is — mid price = uncertain = higher edge
  const score  = clamp(0.5 + Math.abs(price - 0.5) * 0.5);
  return { score, direction: price < 0.5 ? "NO" : "YES", label: best.title.slice(0, 40), event: best };
}

// ─── Composite ────────────────────────────────────────────────────────────────
const WEIGHTS = { crypto: 0.40, btc15m: 0.20, sentiment: 0.20, sports: 0.20 };

export async function runAllSignals(pubKey) {
  const neutral = { score: 0.5, direction: null, label: "error" };

  const [crypto, btc15m, sentiment, sports] = await Promise.all([
    cryptoSignal().catch(() => neutral),
    btc15mSignal().catch(() => neutral),
    sentimentSignal().catch(() => neutral),
    sportsSignal(pubKey).catch(() => neutral),
  ]);

  const composite =
    crypto.score    * WEIGHTS.crypto    +
    btc15m.score    * WEIGHTS.btc15m    +
    sentiment.score * WEIGHTS.sentiment +
    sports.score    * WEIGHTS.sports;

  console.log(`[Signals] crypto:${crypto.score.toFixed(2)} btc15m:${btc15m.score.toFixed(2)} sentiment:${sentiment.score.toFixed(2)} sports:${sports.score.toFixed(2)} → composite:${composite.toFixed(2)}`);

  return { crypto, btc15m, sentiment, sports, composite };
}
