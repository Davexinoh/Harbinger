import { runCryptoSignal }    from "../signals/cryptoSignal.js";
import { runSportsSignal }    from "../signals/sportsSignal.js";
import { runSentimentSignal } from "../signals/sentimentSignal.js";
import { runBTCSignal }       from "../signals/btcSignal.js";
import { getEvents }          from "../bayse/client.js";

const WEIGHTS = {
  crypto:    0.40,
  sports:    0.25,
  sentiment: 0.20,
  btc15m:    0.15,
};

const CACHE_TTL  = 5 * 60 * 1000;
const MIN_PRICE  = 0.25;
const MAX_PRICE  = 0.75;

let cache = { data: {}, ts: 0 };

function neutral(source) {
  return { source, score: 0.5, direction: null, error: "signal_crash" };
}

export async function runAllSignals() {
  const [crypto, sports, sentiment, btc15m] = await Promise.all([
    runCryptoSignal().catch(()    => neutral("crypto")),
    runSportsSignal().catch(()    => neutral("sports")),
    runSentimentSignal().catch(() => neutral("sentiment")),
    runBTCSignal().catch(()       => neutral("btc_15m")),
  ]);

  const composite =
    crypto.score    * WEIGHTS.crypto +
    sports.score    * WEIGHTS.sports +
    sentiment.score * WEIGHTS.sentiment +
    btc15m.score    * WEIGHTS.btc15m;

  return { crypto, sports, sentiment, btc15m, composite };
}

async function fetchEvents(pubKey) {
  const now = Date.now();
  if (cache.ts && now - cache.ts < CACHE_TTL) return cache.data;

  const cats = ["sports", "crypto", "finance", null];

  const res = await Promise.all(
    cats.map(c =>
      getEvents(pubKey, { category: c, status: "open", size: 50 }).catch(() => [])
    )
  );

  const out = {};
  cats.forEach((c, i) => { out[c || "general"] = res[i] || []; });

  cache = { data: out, ts: now };
  return out;
}

function isTradeable(event, market) {
  const eventEngine  = (event.engine  || "").toUpperCase();
  const marketEngine = (market.engine || "").toUpperCase();
  const eventType    = (event.type    || "").toUpperCase();

  if (eventEngine === "AMM" || marketEngine === "AMM") return false;
  if (eventType   === "COMBINED_MARKETS")              return false;
  if (market.status !== "open")                        return false;

  const p = market.outcome1Price ?? 0.5;
  if (p < MIN_PRICE || p > MAX_PRICE)                  return false;

  return true;
}

export async function findMatchingMarket(signals, pubKey, excluded = new Set(), preferred = null) {
  let events;
  try {
    events = await fetchEvents(pubKey);
  } catch (err) {
    console.error("[Scorer] fetchEvents failed:", err.message);
    return null;
  }

  const leader = [signals.crypto, signals.sports, signals.btc15m]
    .filter(s => s?.score != null)
    .sort((a, b) => b.score - a.score)[0];

  if (!leader) return null;

  const direction = (leader.direction === "UP" || leader.direction === "bullish")
    ? "YES" : "NO";

  const allCats     = Object.keys(events);
  const orderedCats = preferred
    ? [preferred, ...allCats.filter(c => c !== preferred)]
    : allCats;

  for (const cat of orderedCats) {
    const pool = (events[cat] || []).filter(e => !excluded.has(e.id));

    for (const event of pool) {
      const market = (event.markets || []).find(m => isTradeable(event, m));
      if (!market) continue;

      console.log(`[Scorer] Selected: "${event.title}" | cat:${cat} | engine:${event.engine || "CLOB"} | p:${market.outcome1Price}`);

      return {
        event,
        market,
        suggestedOutcome: direction,
        signalSource:     leader.source,
        signalScore:      leader.score,
        matchedKeywords:  [],
      };
    }
  }

  console.log("[Scorer] No tradeable CLOB market found this tick");
  return null;
}
