import { runCryptoSignal }    from "../signals/cryptoSignal.js";
import { runSportsSignal }    from "../signals/sportsSignal.js";
import { runSentimentSignal } from "../signals/sentimentSignal.js";
import { getCrowdScore }      from "../signals/crowdSignal.js";
import { getEvents }          from "../bayse/client.js";
import { logSignal }          from "../db/database.js";

const WEIGHTS = { crypto: 0.45, sports: 0.25, sentiment: 0.18, crowd: 0.12 };

const ALL_CATEGORIES = ["sports", "crypto", "politics", "entertainment", "finance", null];

let eventsCache     = {};
let eventsCacheTime = 0;
const EVENTS_CACHE_TTL = 5 * 60 * 1000;

export async function runAllSignals() {
  const [crypto, sports, sentiment, crowd] = await Promise.all([
    runCryptoSignal(),
    runSportsSignal(),
    runSentimentSignal(),
    getCrowdScore(),
  ]);

  logSignal("crypto",    crypto.score,    crypto.best    || null);
  logSignal("sports",    sports.score,    sports.best    || null);
  logSignal("sentiment", sentiment.score, sentiment.best || null);
  logSignal("crowd",     crowd.score,     { votes: crowd.totalVotes, polls: crowd.pollCount });

  const composite =
    crypto.score    * WEIGHTS.crypto    +
    sports.score    * WEIGHTS.sports    +
    sentiment.score * WEIGHTS.sentiment +
    crowd.score     * WEIGHTS.crowd;

  return { crypto, sports, sentiment, crowd, composite, computed_at: new Date().toISOString() };
}

async function fetchAllEvents(publicKey) {
  const now = Date.now();
  if (Object.keys(eventsCache).length && now - eventsCacheTime < EVENTS_CACHE_TTL) {
    return Object.values(eventsCache).flat();
  }

  const results = await Promise.allSettled(
    ALL_CATEGORIES.map(cat => getEvents(publicKey, { category: cat, status: "open", size: 50 }))
  );

  const byCategory = {};
  const seen       = new Set();

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
  console.log(`[Scorer] Fetched ${total} unique open events across all categories`);

  eventsCache     = byCategory;
  eventsCacheTime = now;
  return Object.values(byCategory).flat();
}

// Score an event by keyword relevance + activity
function scoreEvent(event, keywords) {
  const title = (event.title || "").toLowerCase();
  const desc  = (event.description || "").toLowerCase();
  const text  = `${title} ${desc}`;

  let matchScore = 0;
  const matched  = [];

  for (const kw of keywords) {
    if (text.includes(kw.word)) {
      matchScore += kw.weight;
      matched.push(kw.word);
    }
  }

  // Boost by activity
  const activityBoost = Math.min((event.totalOrders || 0) / 1000, 0.3);
  matchScore += activityBoost;

  return { event, matchScore, matched };
}

// findMatchingMarket — respects category preference, skips unsettled event IDs
// unsettledEventIds: Set of event IDs with open trades for this user
export async function findMatchingMarket(signals, publicKey, unsettledEventIds = new Set(), preferredCategory = null) {
  if (!publicKey) return null;

  try {
    await fetchAllEvents(publicKey);

    const keywords = buildKeywords(signals);
    const leader   = signals.crypto.score >= signals.sports.score ? signals.crypto : signals.sports;

    // Determine category priority
    // If user has a preferred category, try it first, then fall back to others
    const categoryOrder = preferredCategory
      ? [preferredCategory, ...ALL_CATEGORIES.filter(c => c !== preferredCategory && c !== null), null]
      : ALL_CATEGORIES;

    for (const category of categoryOrder) {
      const key    = category || "general";
      const pool   = (eventsCache[key] || [])
        .filter(e => !unsettledEventIds.has(e.id)) // skip unsettled
        .filter(e => (e.markets || []).some(m => m.status === "open")); // must have open market

      if (!pool.length) continue;

      // Score events in this category
      const scored = pool
        .map(event => scoreEvent(event, keywords))
        .sort((a, b) => b.matchScore - a.matchScore);

      // Try top match, then second best if first has no open market
      for (const candidate of scored.slice(0, 3)) {
        const market = (candidate.event.markets || []).find(m => m.status === "open");
        if (!market) continue;

        const direction = leader.direction;
        const suggestedOutcome =
          direction === "UP" || direction === "bullish" || direction === "YES"
            ? "YES" : "NO";

        console.log(
          `[Scorer] Match: "${candidate.event.title}" [${key}] | ` +
          `outcome: ${suggestedOutcome} | score: ${candidate.matchScore.toFixed(2)}`
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

    console.log("[Scorer] No matching market found across all categories");
    return null;
  } catch (err) {
    console.error("[Scorer] Error:", err.message);
    return null;
  }
}

function buildKeywords(signals) {
  const kws = [];
  const add = (word, weight) => {
    if (word?.length > 2) kws.push({ word: word.toLowerCase().trim(), weight });
  };

  if (signals.crypto?.best) {
    const b = signals.crypto.best;
    add(b.symbol, 1.5); add(b.coinId, 1.2);
    for (const kw of b.keywords || []) add(kw, 1.0);
    add("bitcoin", 0.8); add("btc", 0.8); add("ethereum", 0.8); add("eth", 0.8); add("crypto", 0.7);
  }

  if (signals.sports?.best) {
    for (const kw of signals.sports.best.keywords || []) add(kw, 0.9);
    add("football", 0.6); add("match", 0.5); add("league", 0.5); add("champions", 0.6); add("premier", 0.6);
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
