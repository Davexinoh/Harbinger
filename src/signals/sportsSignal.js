import { getEvents } from "../bayse/client.js";
import { getActiveUsers } from "../db/database.js";
import { decrypt } from "../utils/encryption.js";

// Cache to avoid hammering Bayse API every tick
let cache = null;
let cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

async function fetchSportsEvents() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL_MS) return cache;

  // Get a public key from any active user — needed to auth the request
  const users = getActiveUsers();
  const pubKey = users.length > 0 ? decrypt(users[0].bayse_pub_key) : null;

  // Fetch sports category events from Bayse — page 1 and 2 for coverage
  const [page1, page2] = await Promise.allSettled([
    getEvents(pubKey, { category: "sports", status: "open", size: 50, page: 1 }),
    getEvents(pubKey, { category: "sports", status: "open", size: 50, page: 2 }),
  ]);

  const events = [
    ...(page1.status === "fulfilled" ? page1.value : []),
    ...(page2.status === "fulfilled" ? page2.value : []),
  ];

  console.log(`[SportsSignal] Fetched ${events.length} open sports events from Bayse`);

  cache = events;
  cacheTime = now;
  return events;
}

// Score a sports event based on market dynamics
// High volume + close odds = active contested market = good signal
// Very skewed odds (>0.85) = market has strong conviction already = less edge
function scoreEvent(event) {
  const openMarkets = (event.markets || []).filter(m => m.status === "open");
  if (!openMarkets.length) return null;

  const market = openMarkets[0];
  const yesPrice = market.outcome1Price || 0.5;
  const noPrice  = market.outcome2Price || 0.5;

  // Market activity score — more orders/volume = more reliable signal
  const activityScore = Math.min((event.totalOrders || 0) / 500, 1);
  const liquidityScore = Math.min((event.liquidity || 0) / 100000, 1);

  // Contestedness: markets near 50/50 are most interesting for signals
  // Markets at 90/10 are already decided — low signal value
  const midpoint = 0.5;
  const deviation = Math.abs(yesPrice - midpoint);
  // Score peaks at 50/50 and drops toward 0 at extremes
  const contestednessScore = 1 - (deviation / 0.5);

  // Closing soon = more urgent = higher signal
  let urgencyScore = 0;
  if (event.closingDate) {
    const hoursLeft = (new Date(event.closingDate) - Date.now()) / (1000 * 60 * 60);
    if (hoursLeft < 24) urgencyScore = 0.3;
    if (hoursLeft < 6)  urgencyScore = 0.6;
    if (hoursLeft < 1)  urgencyScore = 1.0;
  }

  const score = (
    contestednessScore * 0.45 +
    activityScore      * 0.30 +
    liquidityScore     * 0.15 +
    urgencyScore       * 0.10
  );

  // Direction: lean toward YES if market underprices it (yes < 0.45)
  // lean toward NO if market overprices YES (yes > 0.60)
  const direction = yesPrice <= 0.45 ? "YES" : yesPrice >= 0.60 ? "NO" : "YES";

  return {
    eventId:    event.id,
    title:      event.title,
    yesPrice,
    noPrice,
    totalOrders: event.totalOrders || 0,
    liquidity:   event.liquidity || 0,
    closingDate: event.closingDate,
    score:       Math.min(Math.max(score, 0), 1),
    direction,
    keywords:    buildKeywords(event),
  };
}

function buildKeywords(event) {
  const text = `${event.title || ""} ${event.description || ""}`.toLowerCase();
  const stopWords = new Set(["the","a","an","in","on","at","to","for","of","and","or","is","are","was","will","be","who","what","will","how","many","which"]);
  return text
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w))
    .slice(0, 10);
}

export async function runSportsSignal() {
  try {
    const events = await fetchSportsEvents();

    if (!events.length) {
      return {
        source:     "sports",
        score:      0.3,
        direction:  "YES",
        reason:     "No open sports events on Bayse",
        fetched_at: new Date().toISOString(),
      };
    }

    const scored = events
      .map(scoreEvent)
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    const best = scored[0];

    console.log(
      `[SportsSignal] Best: "${best.title}" | ` +
      `score: ${best.score.toFixed(3)} | direction: ${best.direction} | ` +
      `yes: ${best.yesPrice} | orders: ${best.totalOrders}`
    );

    return {
      source:     "sports",
      score:      best.score,
      direction:  best.direction,
      best,
      all:        scored.slice(0, 5),
      fetched_at: new Date().toISOString(),
    };
  } catch (err) {
    console.error("[SportsSignal] Error:", err.message);
    return {
      source:     "sports",
      score:      0.3,
      direction:  "YES",
      error:      err.message,
      fetched_at: new Date().toISOString(),
    };
  }
}
