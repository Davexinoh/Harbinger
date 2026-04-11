import fetch from "node-fetch";

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

// Coins we watch and their corresponding Bayse market keywords
const WATCHED_COINS = [
  { id: "bitcoin", symbol: "BTC", keywords: ["bitcoin", "btc"] },
  { id: "ethereum", symbol: "ETH", keywords: ["ethereum", "eth"] },
  { id: "solana", symbol: "SOL", keywords: ["solana", "sol"] },
];

let cache = null;
let cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchPriceData() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL_MS) return cache;

  const ids = WATCHED_COINS.map((c) => c.id).join(",");
  const url = `${COINGECKO_BASE}/coins/markets?vs_currency=usd&ids=${ids}&price_change_percentage=1h,24h`;

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);

  const data = await res.json();
  cache = data;
  cacheTime = now;
  return data;
}

// Score a single coin's momentum on 0–1 scale
function scoreCoin(coin) {
  const change1h = coin.price_change_percentage_1h_in_currency || 0;
  const change24h = coin.price_change_percentage_24h || 0;
  const volumeRatio =
    coin.total_volume && coin.market_cap
      ? coin.total_volume / coin.market_cap
      : 0;

  // Momentum: weight 1h change more heavily since we're looking for recent moves
  const momentumRaw = change1h * 0.6 + change24h * 0.4;

  // Normalise momentum to 0–1 using a soft sigmoid
  // A 5% move in 1h is extreme — treat that as near-max signal
  const momentum = 1 / (1 + Math.exp(-momentumRaw / 2));

  // Volume spike adds confidence — if volume/mcap ratio is elevated, signal is stronger
  const volumeBoost = Math.min(volumeRatio * 10, 0.15);

  const rawScore = momentum + volumeBoost;
  const score = Math.min(Math.max(rawScore, 0), 1);

  // Determine trade direction
  const direction = momentumRaw > 0 ? "UP" : "DOWN";

  return {
    symbol: coin.symbol.toUpperCase(),
    score,
    direction,
    change1h: change1h.toFixed(2),
    change24h: change24h.toFixed(2),
    price: coin.current_price,
    volumeRatio: volumeRatio.toFixed(4),
  };
}

export async function runCryptoSignal() {
  try {
    const data = await fetchPriceData();

    const scores = data.map((coin) => {
      const meta = WATCHED_COINS.find((c) => c.id === coin.id);
      return {
        ...scoreCoin(coin),
        coinId: coin.id,
        keywords: meta?.keywords || [],
      };
    });

    // Overall signal = highest individual coin score
    const best = scores.reduce((a, b) => (a.score > b.score ? a : b));

    return {
      source: "crypto",
      score: best.score,
      direction: best.direction,
      best,
      all: scores,
      fetched_at: new Date().toISOString(),
    };
  } catch (err) {
    console.error("[CryptoSignal] Error:", err.message);
    return {
      source: "crypto",
      score: 0,
      direction: null,
      error: err.message,
      fetched_at: new Date().toISOString(),
    };
  }
}
