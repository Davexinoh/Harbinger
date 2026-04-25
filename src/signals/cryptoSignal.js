import fetch from "node-fetch";

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

const WATCHED_COINS = [
  { id: "bitcoin",  symbol: "BTC", keywords: ["bitcoin", "btc"] },
  { id: "ethereum", symbol: "ETH", keywords: ["ethereum", "eth"] },
  { id: "solana",   symbol: "SOL", keywords: ["solana", "sol"] },
];

let cache     = null;
let cacheTime = 0;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min — respect CoinGecko free tier limits

async function fetchPriceData() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL_MS) return cache;

  const ids = WATCHED_COINS.map(c => c.id).join(",");
  const url = `${COINGECKO_BASE}/coins/markets?vs_currency=usd&ids=${ids}&price_change_percentage=1h,24h`;

  const res = await fetch(url, {
    headers: {
      Accept:       "application/json",
      "User-Agent": "Harbinger/1.0",
    },
  });

  // Rate limited — serve stale cache if available
  if (res.status === 429) {
    if (cache) {
      console.warn("[CryptoSignal] CoinGecko 429 — using stale cache");
      return cache;
    }
    throw new Error("CoinGecko 429 — no cache available");
  }

  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);

  const data = await res.json();
  cache     = data;
  cacheTime = now;
  return data;
}

function scoreCoin(coin) {
  const change1h  = coin.price_change_percentage_1h_in_currency || 0;
  const change24h = coin.price_change_percentage_24h || 0;
  const volumeRatio =
    coin.total_volume && coin.market_cap
      ? coin.total_volume / coin.market_cap
      : 0;

  const momentumRaw   = change1h * 0.6 + change24h * 0.4;
  const momentum      = 1 / (1 + Math.exp(-momentumRaw / 2));
  const volumeBoost   = Math.min(volumeRatio * 10, 0.15);
  const score         = Math.min(Math.max(momentum + volumeBoost, 0), 1);
  const direction     = momentumRaw > 0 ? "UP" : "DOWN";

  return {
    symbol:    coin.symbol.toUpperCase(),
    score,
    direction,
    change1h:  change1h.toFixed(2),
    change24h: change24h.toFixed(2),
    price:     coin.current_price,
  };
}

export async function runCryptoSignal() {
  try {
    const data = await fetchPriceData();

    const scores = data.map(coin => {
      const meta = WATCHED_COINS.find(c => c.id === coin.id);
      return { ...scoreCoin(coin), coinId: coin.id, keywords: meta?.keywords || [] };
    });

    const best = scores.reduce((a, b) => a.score > b.score ? a : b);

    return {
      source:     "crypto",
      score:      best.score,
      direction:  best.direction,
      best,
      all:        scores,
      fetched_at: new Date().toISOString(),
    };
  } catch (err) {
    console.error("[CryptoSignal] Error:", err.message);
    return {
      source:     "crypto",
      score:      0,
      direction:  null,
      error:      err.message,
      fetched_at: new Date().toISOString(),
    };
  }
}
