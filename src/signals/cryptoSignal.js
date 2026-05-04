import fetch from "node-fetch";

// Binance public API — no key, no rate limits, real-time prices
const BINANCE_BASE = "https://api.binance.com/api/v3";

const WATCHED_PAIRS = [
  { symbol: "BTCUSDT", name: "BTC", coinId: "bitcoin",  keywords: ["bitcoin", "btc"] },
  { symbol: "ETHUSDT", name: "ETH", coinId: "ethereum", keywords: ["ethereum", "eth"] },
  { symbol: "SOLUSDT", name: "SOL", coinId: "solana",   keywords: ["solana", "sol"] },
];

let cache     = null;
let cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchPriceData() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL_MS) return cache;

  const symbols = JSON.stringify(WATCHED_PAIRS.map(p => p.symbol));
  const url     = `${BINANCE_BASE}/ticker/24hr?symbols=${encodeURIComponent(symbols)}`;

  const res = await fetch(url, { headers: { Accept: "application/json" } });

  if (!res.ok) {
    if (cache) { console.warn(`[CryptoSignal] Binance ${res.status} — stale cache`); return cache; }
    throw new Error(`Binance ${res.status}`);
  }

  const data = await res.json();
  cache     = data;
  cacheTime = now;
  return data;
}

async function fetch1hChange(symbol) {
  try {
    const res = await fetch(`${BINANCE_BASE}/klines?symbol=${symbol}&interval=1h&limit=2`);
    if (!res.ok) return 0;
    const klines = await res.json();
    if (klines.length < 2) return 0;
    const prev = parseFloat(klines[0][4]);
    const curr = parseFloat(klines[1][4]);
    return ((curr - prev) / prev) * 100;
  } catch { return 0; }
}

function scoreTicker(ticker, change1h) {
  const change24h   = parseFloat(ticker.priceChangePercent) || 0;
  const volume      = parseFloat(ticker.quoteVolume) || 0;
  const momentumRaw = change1h * 0.6 + change24h * 0.4;
  const momentum    = 1 / (1 + Math.exp(-momentumRaw / 2));
  const volumeBoost = Math.min(volume / 1_000_000_000, 0.15);
  return {
    score:     Math.min(Math.max(momentum + volumeBoost, 0), 1),
    direction: momentumRaw > 0 ? "UP" : "DOWN",
    change1h:  change1h.toFixed(2),
    change24h: change24h.toFixed(2),
  };
}

export async function runCryptoSignal() {
  try {
    const tickers   = await fetchPriceData();
    const changes1h = await Promise.all(WATCHED_PAIRS.map(p => fetch1hChange(p.symbol)));

    const scores = tickers.map((ticker, i) => {
      const pair   = WATCHED_PAIRS.find(p => p.symbol === ticker.symbol) || WATCHED_PAIRS[i];
      const scored = scoreTicker(ticker, changes1h[i] || 0);
      return { symbol: pair.name, coinId: pair.coinId, keywords: pair.keywords, price: parseFloat(ticker.lastPrice), ...scored };
    });

    const best = scores.reduce((a, b) => a.score > b.score ? a : b);
    console.log(`[CryptoSignal] ${best.symbol} score:${best.score.toFixed(3)} ${best.direction} 1h:${best.change1h}%`);

    return { source: "crypto", score: best.score, direction: best.direction, best, all: scores, fetched_at: new Date().toISOString() };
  } catch (err) {
    console.error("[CryptoSignal] Error:", err.message);
    // Neutral fallback — don't drag composite down on transient errors
    return { source: "crypto", score: 0.5, direction: null, error: err.message, fetched_at: new Date().toISOString() };
  }
}
