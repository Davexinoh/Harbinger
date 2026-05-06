import { getEvents } from "../bayse/client.js";

const CACHE_TTL = 4 * 60 * 1000;
let eventCache = { data: null, ts: 0 };

// Only CLOB markets, price between 5¢–95¢, status open, NGN supported
function isTradeable(event, market) {
  if ((event.engine  || "").toUpperCase() === "AMM")  return false;
  if ((market.engine || "").toUpperCase() === "AMM")  return false;
  if (market.status !== "open")                        return false;

  const supportedCurrencies = event.supportedCurrencies || [];
  if (!supportedCurrencies.includes("NGN"))            return false;

  const p = market.outcome1Price;
  if (p == null || p < 0.05 || p > 0.95)              return false;

  return true;
}

export async function findMarket(pubKey, preferredCategory, excludedEventIds = new Set()) {
  const now = Date.now();

  // Refresh cache
  if (!eventCache.data || now - eventCache.ts > CACHE_TTL) {
    const [all, crypto, sports, finance] = await Promise.all([
      getEvents(pubKey, { size: 100, currency: "NGN" }).catch(() => []),
      getEvents(pubKey, { category: "crypto",  size: 50, currency: "NGN" }).catch(() => []),
      getEvents(pubKey, { category: "sports",  size: 50, currency: "NGN" }).catch(() => []),
      getEvents(pubKey, { category: "finance", size: 50, currency: "NGN" }).catch(() => []),
    ]);

    // Deduplicate by id
    const seen = new Set();
    const deduped = [...crypto, ...sports, ...finance, ...all].filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });

    eventCache = { data: deduped, ts: now };
    console.log(`[Scorer] Cache refreshed — ${deduped.length} events`);
  }

  const events = eventCache.data;

  // Build candidate pool — preferred category first, then everything else
  const preferred = preferredCategory && preferredCategory !== "all"
    ? events.filter(e => e.category === preferredCategory)
    : [];
  const rest = events.filter(e => !preferred.includes(e));
  const ordered = [...preferred, ...rest];

  for (const event of ordered) {
    if (excludedEventIds.has(event.id)) continue;

    const market = (event.markets || []).find(m => isTradeable(event, m));
    if (!market) continue;

    console.log(`[Scorer] Selected "${event.title}" | cat:${event.category} | engine:${event.engine} | p:${market.outcome1Price}`);
    return { event, market };
  }

  console.log("[Scorer] No tradeable market found");
  return null;
}
