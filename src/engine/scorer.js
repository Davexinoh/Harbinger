import { runCryptoSignal }    from "../signals/cryptoSignal.js";
import { runSportsSignal }    from "../signals/sportsSignal.js";
import { runSentimentSignal } from "../signals/sentimentSignal.js";
import { getCrowdScore }      from "../signals/crowdSignal.js";
import { getEvents }          from "../bayse/client.js";
import { logSignal }          from "../db/database.js";

const WEIGHTS = { crypto: 0.45, sports: 0.25, sentiment: 0.18, crowd: 0.12 };

// All Bayse event categories
const CATEGORIES = ["sports", "crypto", "politics", "entertainment", "finance", null];

// Cache all open events across categories — refresh every 5 min
let eventsCache    = [];
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

// Fetch all open events across all categories
async function fetchAllEvents(publicKey) {
  const now = Date.now();
  if (eventsCache.length && now - eventsCacheTime < EVENTS_CACHE_TTL) {
    return eventsCache;
  }

  const results = await Promise.allSettled(
    CATEGORIES.map(cat => getEvents(publicKey, { category: cat, status: "open", size: 50 }))
  );

  const all = [];
  const seen = new Set();

  for (const r of results) {
    if (r.status === "fulfilled") {
      for (const event of r.value) {
        if (!seen.has(event.id)) {
          seen.add(event.id);
          all.push(event);
        }
      }
    }
  }

  console.log(`[Scorer] Fetched ${all.length} unique open events across all categories`);
  eventsCache    = all;
  eventsCacheTime = now;
  return all;
}

// findMatchingMarket — avoids repeating lastEventId
export async function findMatchingMarket(signals, publicKey, lastEventId = null) {
  if (!publicKey) {
    console.log("[Scorer] No public key");
    return null;
  }

  try {
    const events = await fetchAllEvents(publicKey);
    if (!events.length) {
      console.log("[Scorer] No events from Bayse");
      return null;
    }

    const keywords = buildKeywords(signals);
    const leader   = signals.crypto.score >= signals.sports.score
      ? signals.crypto
      : signals.sports;

    // Score events — filter out the last traded one
    const scored = events
      .filter(e => e.id !== lastEventId) // never repeat last event
      .map(event => {
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

        // Boost events with more activity — prefer liquid markets
        const activityBoost = Math.min((event.totalOrders || 0) / 1000, 0.3);
        matchScore += activityBoost;

        return { event, matchScore, matched };
      })
      .filter(e => e.matchScore > 0)
      .sort((a, b) => b.matchScore - a.matchScore);

    // Fallback: if no keyword match, pick highest-activity event (not the last one)
    const best = scored[0] || {
      event: events.find(e => e.id !== lastEventId) || events[0],
      matched: ["fallback"],
      matchScore: 0,
    };

    const event  = best.event;
    const market = (event.markets || []).find(m => m.status === "open") || event.markets?.[0];

    if (!market) {
      console.log(`[Scorer] No open market on "${event.title}"`);
      return null;
    }

    const direction = leader.direction;
    const suggestedOutcome =
      direction === "UP" || direction === "bullish" || direction === "YES"
        ? "YES" : "NO";

    console.log(
      `[Scorer] Match: "${event.title}" | ` +
      `outcome: ${suggestedOutcome} | keywords: [${best.matched.slice(0, 3).join(", ")}]`
    );

    return { event, market, matchedKeywords: best.matched, signalSource: leader.source, signalScore: leader.score, suggestedOutcome };
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

  // Crypto keywords
  if (signals.crypto?.best) {
    const b = signals.crypto.best;
    add(b.symbol, 1.5);
    add(b.coinId, 1.2);
    for (const kw of b.keywords || []) add(kw, 1.0);
    add("bitcoin", 0.8); add("btc", 0.8);
    add("ethereum", 0.8); add("eth", 0.8);
    add("crypto", 0.7); add("price", 0.5);
  }

  // Sports keywords — now from Bayse event title
  if (signals.sports?.best) {
    const b = signals.sports.best;
    for (const kw of b.keywords || []) add(kw, 0.9);
    add("football", 0.6); add("match", 0.5);
    add("league", 0.5); add("cup", 0.5);
    add("champions", 0.6); add("premier", 0.6);
  }

  // Sentiment keywords from headline
  if (signals.sentiment?.best) {
    const stopWords = new Set(["the","a","an","in","on","at","to","for","of","and","or","is","are","was","were","be","has","have","had","will","that","this","with","from","by","as","it","but","not","do","did"]);
    const words = (signals.sentiment.best.title || "")
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3 && !stopWords.has(w));
    for (const w of words.slice(0, 6)) add(w, 0.6);
  }

  // Universal Bayse terms
  add("ngn", 0.7); add("naira", 0.7); add("nigeria", 0.8); add("africa", 0.6);
  add("election", 0.8); add("president", 0.7); add("government", 0.6);
  add("forex", 0.7); add("rate", 0.5); add("dollar", 0.6);

  return kws;
}
