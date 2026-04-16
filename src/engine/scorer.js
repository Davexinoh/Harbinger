import { runCryptoSignal }    from "../signals/cryptoSignal.js";
import { runSportsSignal }    from "../signals/sportsSignal.js";
import { runSentimentSignal } from "../signals/sentimentSignal.js";
import { getCrowdScore }      from "../signals/crowdSignal.js";
import { getEvents }          from "../bayse/client.js";
import { logSignal }          from "../db/database.js";

const WEIGHTS = { crypto: 0.45, sports: 0.25, sentiment: 0.18, crowd: 0.12 };

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

// publicKey is required — Bayse gates all market data behind auth
export async function findMatchingMarket(signals, publicKey) {
  if (!publicKey) {
    console.log("[Scorer] No public key — cannot fetch markets");
    return null;
  }

  try {
    const events = await getEvents(publicKey, { status: "open", size: 100 });
    if (!Array.isArray(events) || !events.length) {
      console.log("[Scorer] No events returned from Bayse");
      return null;
    }

    console.log(`[Scorer] Matching signals against ${events.length} open events`);

    const keywords = buildKeywords(signals);
    const leader   = signals.crypto.score >= signals.sports.score
      ? signals.crypto
      : signals.sports;

    const scored = events.map((event) => {
      const title = (event.title || event.name || "").toLowerCase();
      const desc  = (event.description || event.question || "").toLowerCase();
      const text  = `${title} ${desc}`;

      let matchScore = 0;
      const matched  = [];

      for (const kw of keywords) {
        if (text.includes(kw.word)) {
          matchScore += kw.weight;
          matched.push(kw.word);
        }
      }

      return { event, matchScore, matched };
    }).filter((e) => e.matchScore > 0).sort((a, b) => b.matchScore - a.matchScore);

    // Fallback to first event if no keyword match
    const best   = scored[0] || { event: events[0], matched: ["first-available"], matchScore: 0 };
    const event  = best.event;
    const market = (event.markets || []).find((m) => m.status === "open") || event.markets?.[0];

    if (!market) {
      console.log(`[Scorer] No open market on "${event.title}"`);
      return null;
    }

    const direction = leader.direction;
    const suggestedOutcome =
      direction === "UP" || direction === "bullish" || direction === "YES" || direction === "home"
        ? "YES" : "NO";

    console.log(`[Scorer] Match: "${event.title}" | outcome: ${suggestedOutcome} | keywords: [${best.matched.join(", ")}]`);

    return { event, market, matchedKeywords: best.matched, signalSource: leader.source, signalScore: leader.score, suggestedOutcome };
  } catch (err) {
    console.error("[Scorer] Market match error:", err.message);
    return null;
  }
}

function buildKeywords(signals) {
  const kws = [];
  const add = (word, weight) => { if (word?.length > 2) kws.push({ word: word.toLowerCase(), weight }); };

  if (signals.crypto?.best) {
    const b = signals.crypto.best;
    add(b.symbol, 1.5); add(b.coinId, 1.2);
    for (const kw of b.keywords || []) add(kw, 1.0);
    add("bitcoin", 0.8); add("btc", 0.8); add("ethereum", 0.8); add("eth", 0.8); add("crypto", 0.7);
  }

  if (signals.sports?.best) {
    const b = signals.sports.best;
    add(b.homeTeam, 1.5); add(b.awayTeam, 1.5); add(b.league, 1.0); add(b.country, 0.8);
    for (const kw of b.keywords || []) add(kw, 0.8);
    add("football", 0.6); add("match", 0.5); add("win", 0.5); add("premier", 0.7); add("champions", 0.7);
  }

  if (signals.sentiment?.best) {
    const stopWords = new Set(["the","a","an","in","on","at","to","for","of","and","or","is","are","was","were","be","has","have","had","will","that","this","with","from","by","as","it","but","not","do","did"]);
    const words = (signals.sentiment.best.title || "").toLowerCase().split(/\s+/).filter((w) => w.length > 3 && !stopWords.has(w));
    for (const w of words.slice(0, 5)) add(w, 0.6);
  }

  add("ngn", 0.7); add("naira", 0.7); add("nigeria", 0.7); add("africa", 0.6);
  add("election", 0.8); add("forex", 0.7); add("price", 0.5);

  return kws;
}
