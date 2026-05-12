import { getEvents } from "../bayse/client.js";

const CACHE_TTL = 4 * 60 * 1000;
let eventCache = { data: null, ts: 0 };

function isTradeable(event, market) {
  if ((event.engine  || "").toUpperCase() === "AMM") return false;
  if ((market.engine || "").toUpperCase() === "AMM") return false;
  if (market.status !== "open")                       return false;
  const p = market.outcome1Price;
  if (p == null || p < 0.05 || p > 0.95)             return false;
  return true;
}

// strictCategory=true means ONLY return markets matching preferred — no fallback
export async function findMarket(pubKey, preferred = null, excluded = new Set(), strictCategory = false) {
  const now = Date.now();

  if (!eventCache.data || now - eventCache.ts > CACHE_TTL) {
    const categories = ["crypto", "sports", "finance", "politics", "entertainment"];
    const results    = await Promise.all(
      categories.map(c =>
        getEvents(pubKey, { category: c, size: 50, currency: "NGN" }).catch(() => [])
      )
    );

    // Tag each event with its category and deduplicate
    const seen = new Set();
    const all  = [];
    categories.forEach((cat, i) => {
      for (const e of results[i] || []) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          all.push({ ...e, _category: cat });
        }
      }
    });

    eventCache = { data: all, ts: now };
    console.log(`[Scorer] Cache refreshed — ${all.length} events`);
  }

  const events = eventCache.data;

  // Build pool — strict mode: only preferred category
  let pool = preferred
    ? events.filter(e => e._category === preferred || e.category === preferred)
    : events;

  // If strict and no events in category, log and return null — don't fall back
  if (strictCategory && preferred && pool.length === 0) {
    console.log(`[Scorer] No events in category "${preferred}" — not falling back`);
    return null;
  }

  // If not strict and preferred has nothing, use all
  if (!strictCategory && preferred && pool.length === 0) {
    pool = events;
  }

  for (const event of pool) {
    if (excluded.has(event.id)) continue;
    const market = (event.markets || []).find(m => isTradeable(event, m));
    if (!market) continue;

    console.log(`[Scorer] Selected "${event.title}" | cat:${event._category || event.category} | engine:${event.engine} | p:${market.outcome1Price}`);
    return { event, market };
  }

  console.log(`[Scorer] No tradeable market found (preferred: ${preferred || "all"})`);
  return null;
}
