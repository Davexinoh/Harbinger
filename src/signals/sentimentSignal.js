import Parser from "rss-parser";

const parser = new Parser({ timeout: 8000 });

const FEEDS = [
  { url: "https://feeds.bbci.co.uk/sport/africa/rss.xml", weight: 1.0, name: "BBC Sport Africa" },
  { url: "https://coindesk.com/arc/outboundfeeds/rss/", weight: 0.9, name: "CoinDesk" },
  { url: "https://cointelegraph.com/rss", weight: 0.85, name: "CoinTelegraph" },
  { url: "https://www.premiumtimesng.com/feed", weight: 0.8, name: "Premium Times NG" },
];

// Positive signal keywords — increase confidence in bullish/outcome prediction
const BULLISH_KEYWORDS = [
  "wins", "winner", "victory", "beats", "defeats", "surges", "rallies",
  "record high", "all-time high", "breakout", "dominates", "breakthrough",
  "qualifies", "advances", "unbeaten", "streak",
];

// Negative/bearish keywords
const BEARISH_KEYWORDS = [
  "loses", "crash", "plunge", "fall", "drops", "decline", "scandal",
  "suspended", "banned", "injury", "crisis", "collapse", "fraud",
];

// Market relevance keywords — if present, headline is relevant to Bayse markets
const MARKET_KEYWORDS = [
  "bitcoin", "btc", "ethereum", "eth", "solana", "sol", "crypto",
  "naira", "ngn", "forex", "election", "president", "premier league",
  "afcon", "nigeria", "africa", "football", "world cup",
];

let feedCache = null;
let feedCacheTime = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function fetchAllFeeds() {
  const now = Date.now();
  if (feedCache && now - feedCacheTime < CACHE_TTL_MS) return feedCache;

  const items = [];
  for (const feed of FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);
      const recent = (parsed.items || []).slice(0, 15).map((item) => ({
        title: item.title || "",
        summary: item.contentSnippet || item.summary || "",
        pubDate: item.pubDate,
        feedName: feed.name,
        weight: feed.weight,
      }));
      items.push(...recent);
    } catch (err) {
      console.error(`[SentimentSignal] Feed ${feed.name} failed:`, err.message);
    }
  }

  // Filter to last 2 hours only
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  const fresh = items.filter((item) => {
    if (!item.pubDate) return true; // include if no date
    return new Date(item.pubDate).getTime() > cutoff;
  });

  feedCache = fresh;
  feedCacheTime = now;
  return fresh;
}

function scoreHeadline(item) {
  const text = `${item.title} ${item.summary}`.toLowerCase();

  // Check market relevance first
  const isRelevant = MARKET_KEYWORDS.some((kw) => text.includes(kw));
  if (!isRelevant) return null;

  let bullishScore = 0;
  let bearishScore = 0;

  for (const kw of BULLISH_KEYWORDS) {
    if (text.includes(kw)) bullishScore += 1;
  }
  for (const kw of BEARISH_KEYWORDS) {
    if (text.includes(kw)) bearishScore += 1;
  }

  const totalSignal = bullishScore + bearishScore;
  if (totalSignal === 0) return null;

  const sentiment = bullishScore > bearishScore ? "bullish" : "bearish";
  const rawScore = totalSignal / 4; // cap at 4 keyword hits = max score
  const score = Math.min(rawScore, 1) * item.weight;

  return {
    title: item.title,
    feedName: item.feedName,
    sentiment,
    bullishHits: bullishScore,
    bearishHits: bearishScore,
    score,
    pubDate: item.pubDate,
  };
}

export async function runSentimentSignal() {
  try {
    const items = await fetchAllFeeds();

    const scored = items
      .map(scoreHeadline)
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    if (!scored.length) {
      return {
        source: "sentiment",
        score: 0,
        direction: null,
        reason: "No relevant headlines in last 2 hours",
        fetched_at: new Date().toISOString(),
      };
    }

    // Aggregate: average top 3 scores
    const top3 = scored.slice(0, 3);
    const avgScore = top3.reduce((s, h) => s + h.score, 0) / top3.length;
    const dominantSentiment =
      top3.filter((h) => h.sentiment === "bullish").length >= top3.length / 2
        ? "bullish"
        : "bearish";

    return {
      source: "sentiment",
      score: avgScore,
      direction: dominantSentiment,
      best: top3[0],
      top3,
      fetched_at: new Date().toISOString(),
    };
  } catch (err) {
    console.error("[SentimentSignal] Error:", err.message);
    return {
      source: "sentiment",
      score: 0,
      direction: null,
      error: err.message,
      fetched_at: new Date().toISOString(),
    };
  }
}
