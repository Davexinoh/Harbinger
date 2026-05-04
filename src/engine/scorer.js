import { runCryptoSignal } from "../signals/cryptoSignal.js";
import { runSportsSignal } from "../signals/sportsSignal.js";
import { runSentimentSignal } from "../signals/sentimentSignal.js";
import { runBTCSignal } from "../signals/btcSignal.js";
import { getEvents } from "../bayse/client.js";
import { logSignal } from "../db/database.js";

const WEIGHTS = {
  crypto: 0.40,
  sports: 0.25,
  sentiment: 0.20,
  btc15m: 0.15,
};

const CACHE_TTL = 5 * 60 * 1000;
let cache = { data: {}, ts: 0 };

const MIN_PRICE = 0.25;
const MAX_PRICE = 0.75;

export async function runAllSignals() {
  const [crypto, sports, sentiment, btc15m] = await Promise.all([
    runCryptoSignal(),
    runSportsSignal(),
    runSentimentSignal(),
    runBTCSignal(),
  ]);

  const composite =
    crypto.score * WEIGHTS.crypto +
    sports.score * WEIGHTS.sports +
    sentiment.score * WEIGHTS.sentiment +
    btc15m.score * WEIGHTS.btc15m;

  return { crypto, sports, sentiment, btc15m, composite };
}

async function fetchEvents(pubKey) {
  const now = Date.now();
  if (cache.ts && now - cache.ts < CACHE_TTL) return cache.data;

  const cats = ["sports", "crypto", "finance", null];

  const res = await Promise.all(
    cats.map(c =>
      getEvents(pubKey, { category: c, status: "open", size: 50 })
    )
  );

  const out = {};
  cats.forEach((c, i) => {
    out[c || "general"] = res[i] || [];
  });

  cache = { data: out, ts: now };
  return out;
}

function inRange(market) {
  const p = market?.outcome1Price ?? 0.5;
  return p >= MIN_PRICE && p <= MAX_PRICE;
}

export async function findMatchingMarket(signals, pubKey, excluded = new Set(), preferred = null) {
  const events = await fetchEvents(pubKey);
  const leader = [signals.crypto, signals.sports, signals.btc15m]
    .sort((a, b) => b.score - a.score)[0];

  const direction = leader.direction === "UP" || leader.direction === "bullish"
    ? "YES"
    : "NO";

  const categories = preferred ? [preferred, "general"] : Object.keys(events);

  for (const cat of categories) {
    const pool = (events[cat] || [])
      .filter(e => !excluded.has(e.id));

    for (const event of pool) {
      const market = event.markets?.find(m => m.status === "open");
      if (!market || !inRange(market)) continue;

      return {
        event,
        market,
        suggestedOutcome: direction,
        signalSource: leader.source,
        signalScore: leader.score,
        matchedKeywords: [],
      };
    }
  }

  return null;
}
