import { runCryptoSignal } from "../signals/cryptoSignal.js";
import { runSportsSignal } from "../signals/sportsSignal.js";
import { runSentimentSignal } from "../signals/sentimentSignal.js";
import { getCrowdScore } from "../signals/crowdSignal.js";
import { getEvents } from "../bayse/client.js";
import { logSignal } from "../db/database.js";

// Signal weights — crowd signal is the 4th input
// Reduced other weights slightly to make room for crowd
const WEIGHTS = {
  crypto:    0.38,
  sports:    0.28,
  sentiment: 0.16,
  crowd:     0.18,
};

export async function runAllSignals() {
  const [crypto, sports, sentiment, crowd] = await Promise.all([
    runCryptoSignal(),
    runSportsSignal(),
    runSentimentSignal(),
    getCrowdScore(),
  ]);

  // Log algorithmic signals to DB (crowd already has its own table)
  logSignal("crypto",    crypto.score,    crypto.best    || null);
  logSignal("sports",    sports.score,    sports.best    || null);
  logSignal("sentiment", sentiment.score, sentiment.best || null);
  logSignal("crowd",     crowd.score,     { votes: crowd.totalVotes, polls: crowd.pollCount });

  const composite =
    crypto.score    * WEIGHTS.crypto    +
    sports.score    * WEIGHTS.sports    +
    sentiment.score * WEIGHTS.sentiment +
    crowd.score     * WEIGHTS.crowd;

  return {
    crypto,
    sports,
    sentiment,
    crowd,
    composite,
    computed_at: new Date().toISOString(),
  };
}

// Find the best Bayse market that matches the strongest signal
export async function findMatchingMarket(signals) {
  try {
    const events = await getEvents(null, "open", 50);
    if (!events?.data?.length) return null;

    const { crypto, sports } = signals;

    // Determine which algorithmic signal is leading
    const leader = crypto.score >= sports.score ? crypto : sports;

    const keywords =
      leader.source === "crypto"
        ? leader.best?.keywords || []
        : leader.best?.keywords || [];

    if (!keywords.length) return null;

    for (const event of events.data) {
      const title       = (event.title       || "").toLowerCase();
      const description = (event.description || "").toLowerCase();
      const text = `${title} ${description}`;

      const matches = keywords.filter((kw) => text.includes(kw));
      if (matches.length > 0 && event.markets?.length > 0) {
        const market = event.markets.find((m) => m.status === "open");
        if (market) {
          return {
            event,
            market,
            matchedKeywords: matches,
            signalSource: leader.source,
            signalScore: leader.score,
            suggestedOutcome:
              leader.direction === "UP" || leader.direction === "bullish" || leader.direction === "YES"
                ? "YES"
                : "NO",
          };
        }
      }
    }

    return null;
  } catch (err) {
    console.error("[Scorer] Market match error:", err.message);
    return null;
  }
}
