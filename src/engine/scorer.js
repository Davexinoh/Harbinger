import { runCryptoSignal }    from "../signals/cryptoSignal.js";
import { runSportsSignal }    from "../signals/sportsSignal.js";
import { runSentimentSignal } from "../signals/sentimentSignal.js";
import { runBTCSignal }       from "../signals/btcSignal.js";
import { getCrowdScore }      from "../signals/crowdSignal.js";
import { getEvents }          from "../bayse/client.js";
import { logSignal }          from "../db/database.js";

// Standard weights
const WEIGHTS_DEFAULT = { crypto: 0.40, sports: 0.22, sentiment: 0.18, crowd: 0.10, btc15m: 0.10 };
// Crypto category — BTC 15m gets a much bigger say
const WEIGHTS_CRYPTO  = { crypto: 0.25, sports: 0.05, sentiment: 0.15, crowd: 0.10, btc15m: 0.45 };

const ALL_CATEGORIES = ["sports", "crypto", "politics", "entertainment", "finance", null];

let eventsCache     = {};
let eventsCacheTime = 0;
const EVENTS_CACHE_TTL = 5 * 60 * 1000;

export async function runAllSignals(preferredCategory = null) {
  const [crypto, sports, sentiment, crowd, btc15m] = await Promise.all([
    runCryptoSignal(),
    runSportsSignal(),
    runSentimentSignal(),
    getCrowdScore(),
    runBTCSignal(),
  ]);

  // Use crypto weights when user has crypto category selected
  const W = preferredCategory === "crypto" ? WEIGHTS_CRYPTO : WEIGHTS_DEFAULT;

  const composite =
    crypto.score    * W.crypto    +
    sports.score    * W.sports    +
    sentiment.score * W.sentiment +
    crowd.score     * W.crowd     +
    btc15m.score    * W.btc15m;

  // Log signals (fire and forget)
  Promise.all([
    logSignal("crypto",    crypto.score,    crypto.best    || null),
    logSignal("sports",    sports.score,    sports.best    || null),
    logSignal("sentiment", sentiment.score, sentiment.best || null),
    logSignal("btc_15m",   btc15m.score,    btc15m         || null),
  ]).catch(() => {});

  return { crypto, sports, sentiment, crowd, btc15m, composite, computed_at: new Date().toISOString() };
}

async function fetchAllEvents(publicKey) {
  const now = Date.now();
  if (Object.keys(eventsCache).length && now - eventsCacheTime < EVENTS_CACHE_TTL) {
    return eventsCache;
  }

  const results = await Promise.allSettled(
    ALL_CATEGORIES.map(cat => getEvents(publicKey, { category: cat, status: "open", size: 50 }))
  );

  const byCategory = {};
  const seen = new Set();

  ALL_CATEGORIES.forEach((cat, i) => {
    const key = cat || "general";
    byCategory[key] = [];
    if (results[i].status === "fulfilled") {
      for (const event of results[i].value) {
        if (!seen.has(event.id)) {
          seen.add(event.id);
          byCategory[key].push(event);
        }
      }
    }
  });

  const total = Object.values(byCategory).flat().length;
  console.log(`[Scorer] Cached ${total} unique events`);
  eventsCache     = byCategory;
  eventsCacheTime = now;
  return byCategory;
}

function scoreEvent(event, keywords) {
  const text = `${(event.title || "").toLowerCase()} ${(event.description || "").toLowerCase()}`;
  let matchScore = 0;
  const matched  = [];
  for (const kw of keywords) {
    if (text.includes(kw.word)) { matchScore += kw.weight; matched.push(kw.word); }
  }
  matchScore += Math.min((event.totalOrders || 0) / 1000, 0.3);
  return { event, matchScore, matched };
}

export async function findMatchingMarket(signals, publicKey, unsettledEventIds = new Set(), preferredCategory = null) {
  if (!publicKey) return null;

  try {
    const cache = await fetchAllEvents(publicKey);
    const keywords = buildKeywords(signals);

    // For crypto category — use BTC 15m direction as leader
    const btcLeading = preferredCategory === "crypto" && signals.btc15m?.score > 0.55;
    const leader     = btcLeading
      ? signals.btc15m
      : (signals.crypto.score >= signals.sports.score ? signals.crypto : signals.sports);

    const categoryOrder = preferredCategory
      ? [preferredCategory, ...ALL_CATEGORIES.filter(c => c !== preferredCategory && c !== null), null]
      : ALL_CATEGORIES;

    for (const category of categoryOrder) {
      const key  = category || "general";
      const pool = (cache[key] || [])
        .filter(e => !unsettledEventIds.has(e.id))
        .filter(e => (e.markets || []).some(m => m.status === "open"));

      if (!pool.length) continue;

      const scored = pool
        .map(event => scoreEvent(event, keywords))
        .sort((a, b) => b.matchScore - a.matchScore);

      for (const candidate of scored.slice(0, 3)) {
        const market = (candidate.event.markets || []).find(m => m.status === "open");
        if (!market) continue;

        // Determine direction from leader signal
        const direction = leader.direction;
        const suggestedOutcome =
          direction === "UP" || direction === "bullish" || direction === "YES" || direction === "home"
            ? "YES" : "NO";

        console.log(
          `[Scorer] Match: "${candidate.event.title}" [${key}] | ` +
          `${suggestedOutcome} | leader: ${leader.source} ${leader.direction}`
        );

        return {
          event:           candidate.event,
          market,
          matchedKeywords: candidate.matched.slice(0, 3),
          signalSource:    leader.source,
          signalScore:     leader.score,
          suggestedOutcome,
          category:        key,
        };
      }
    }

    return null;
  } catch (err) {
    console.error("[Scorer] Error:", err.message);
    return null;
  }
}

function buildKeywords(signals) {
  const kws = [];
  const add  = (word, weight) => { if (word?.length > 2) kws.push({ word: word.toLowerCase().trim(), weight }); };

  if (signals.crypto?.best) {
    const b = signals.crypto.best;
    add(b.symbol, 1.5); add(b.coinId, 1.2);
    for (const kw of b.keywords || []) add(kw, 1.0);
    add("bitcoin", 0.8); add("btc", 0.8); add("ethereum", 0.8); add("eth", 0.8); add("crypto", 0.7);
  }

  if (signals.btc15m?.score > 0.5) {
    add("bitcoin", 1.5); add("btc", 1.5);
    add("15", 1.2); add("minutes", 1.0); add("price", 0.8);
    add("up", 0.7); add("down", 0.7);
  }

  if (signals.sports?.best) {
    for (const kw of signals.sports.best.keywords || []) add(kw, 0.9);
    add("football", 0.6); add("match", 0.5); add("league", 0.5);
  }

  if (signals.sentiment?.best) {
    const stopWords = new Set(["the","a","an","in","on","at","to","for","of","and","or","is","are","was","were","be","has","have","had","will","that","this","with","from","by","as","it","but","not","do","did"]);
    const words = (signals.sentiment.best.title || "").toLowerCase().split(/\s+/).filter(w => w.length > 3 && !stopWords.has(w));
    for (const w of words.slice(0, 6)) add(w, 0.6);
  }

  add("ngn", 0.7); add("naira", 0.7); add("nigeria", 0.8); add("africa", 0.6);
  add("election", 0.8); add("president", 0.7); add("forex", 0.7);

  return kws;
}
