import fetch from "node-fetch";
import Parser from "rss-parser";

const parser = new Parser({
  timeout: 12000,
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; Harbinger/1.0; +https://harbinger.onrender.com)",
    Accept: "application/rss+xml, application/xml, text/xml, */*",
  },
});

// Expanded feed list with fallbacks — if one fails others cover
const FEEDS = [
  { url: "https://feeds.bbci.co.uk/sport/football/rss.xml",      weight: 1.0,  name: "BBC Sport Football" },
  { url: "https://feeds.bbci.co.uk/sport/africa/rss.xml",        weight: 1.0,  name: "BBC Sport Africa" },
  { url: "https://feeds.bbci.co.uk/news/business/rss.xml",       weight: 0.85, name: "BBC Business" },
  { url: "https://coindesk.com/arc/outboundfeeds/rss/",          weight: 0.9,  name: "CoinDesk" },
  { url: "https://cointelegraph.com/rss",                        weight: 0.85, name: "CoinTelegraph" },
  { url: "https://decrypt.co/feed",                              weight: 0.8,  name: "Decrypt" },
  { url: "https://www.premiumtimesng.com/feed",                  weight: 0.8,  name: "Premium Times NG" },
  { url: "https://techcabal.com/feed/",                          weight: 0.75, name: "TechCabal" },
  { url: "https://nairametrics.com/feed/",                       weight: 0.8,  name: "Nairametrics" },
];

const BULLISH_KEYWORDS = [
  "wins", "winner", "victory", "beats", "defeats", "surges", "rallies",
  "record high", "all-time high", "breakout", "dominates", "breakthrough",
  "qualifies", "advances", "unbeaten", "streak", "rises", "jumps", "soars",
  "bullish", "rally", "gains", "growth", "positive", "strong", "up",
  "approval", "launch", "partnership", "milestone", "success",
];

const BEARISH_KEYWORDS = [
  "loses", "crash", "plunge", "fall", "drops", "decline", "scandal",
  "suspended", "banned", "injury", "crisis", "collapse", "fraud",
  "bearish", "dump", "sell-off", "warning", "risk", "trouble", "concern",
  "investigation", "fine", "lawsuit", "hack", "exploit", "loss",
];

const MARKET_KEYWORDS = [
  "bitcoin", "btc", "ethereum", "eth", "solana", "sol", "crypto",
  "naira", "ngn", "forex", "election", "president",
  "premier league", "champions league", "afcon", "world cup",
  "nigeria", "africa", "football", "soccer", "match",
  "market", "price", "trading", "prediction", "odds",
  "defi", "token", "blockchain", "web3",
];

let feedCache = null;
let feedCacheTime = 0;
const CACHE_TTL_MS = 8 * 60 * 1000; // 8 min — refresh more often

async function fetchFeedWithTimeout(feed) {
  return Promise.race([
    parser.parseURL(feed.url),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), 12_000)
    ),
  ]);
}

async function fetchAllFeeds() {
  const now = Date.now();
  if (feedCache && now - feedCacheTime < CACHE_TTL_MS) return feedCache;

  const items = [];
  let successCount = 0;

  // Fetch all feeds in parallel — don't wait for slow ones
  const results = await Promise.allSettled(
    FEEDS.map((feed) =>
      fetchFeedWithTimeout(feed).then((parsed) => ({ parsed, feed }))
    )
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      const { parsed, feed } = result.value;
      const recent = (parsed.items || []).slice(0, 20).map((item) => ({
        title: item.title || "",
        summary: item.contentSnippet || item.summary || "",
        pubDate: item.pubDate || item.isoDate,
        feedName: feed.name,
        weight: feed.weight,
      }));
      items.push(...recent);
      successCount++;
    } else {
      console.log(`[SentimentSignal] Feed failed: ${result.reason?.message}`);
    }
  }

  console.log(`[SentimentSignal] ${successCount}/${FEEDS.length} feeds loaded, ${items.length} items`);

  // Use last 4 hours instead of 2 — wider net
  const cutoff = Date.now() - 4 * 60 * 60 * 1000;
  const fresh = items.filter((item) => {
    if (!item.pubDate) return true;
    return new Date(item.pubDate).getTime() > cutoff;
  });

  // If fresh filter kills everything, use all items (feed dates may be unreliable)
  const final = fresh.length >= 5 ? fresh : items;
  console.log(`[SentimentSignal] ${final.length} items after time filter`);

  feedCache = final;
  feedCacheTime = now;
  return final;
}

function scoreHeadline(item) {
  const text = `${item.title} ${item.summary}`.toLowerCase();

  const isRelevant = MARKET_KEYWORDS.some((kw) => text.includes(kw));
  if (!isRelevant) return null;

  let bullishScore = 0;
  let bearishScore = 0;

  for (const kw of BULLISH_KEYWORDS) {
    if (text.includes(kw)) bullishScore++;
  }
  for (const kw of BEARISH_KEYWORDS) {
    if (text.includes(kw)) bearishScore++;
  }

  // Count as signal even with just 1 keyword hit if the headline is relevant
  const totalSignal = bullishScore + bearishScore;
  if (totalSignal === 0) {
    // Relevant but neutral — still counts as weak signal
    return {
      title: item.title,
      feedName: item.feedName,
      sentiment: "neutral",
      bullishHits: 0,
      bearishHits: 0,
      score: 0.15 * item.weight,
      pubDate: item.pubDate,
    };
  }

  const sentiment = bullishScore >= bearishScore ? "bullish" : "bearish";
  const rawScore = Math.min(totalSignal / 3, 1);
  const score = rawScore * item.weight;

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
        score: 0.2,
        direction: "bullish",
        reason: "No relevant headlines — using baseline",
        fetched_at: new Date().toISOString(),
      };
    }

    const top3 = scored.slice(0, 3);
    const avgScore = top3.reduce((s, h) => s + h.score, 0) / top3.length;
    const bullishCount = top3.filter((h) => h.sentiment === "bullish").length;
    const dominantSentiment = bullishCount >= Math.ceil(top3.length / 2) ? "bullish" : "bearish";

    console.log(`[SentimentSignal] ${scored.length} relevant headlines | avg: ${avgScore.toFixed(3)} | ${dominantSentiment}`);

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
      score: 0.2,
      direction: "bullish",
      error: err.message,
      fetched_at: new Date().toISOString(),
    };
  }
}
