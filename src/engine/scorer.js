import { getEvents } from "../bayse/client.js";

const CACHE_TTL  = 3 * 60 * 1000; // 3 min cache
const MIN_PRICE  = 0.20; // tightened from 0.05
const MAX_PRICE  = 0.75; // tightened from 0.95
const MIN_ORDERS = 15;   // minimum liquidity

let eventCache = { data: null, ts: 0 };

function isTradeable(event, market) {
  if ((event.engine  || "").toUpperCase() === "AMM") return false;
  if ((market.engine || "").toUpperCase() === "AMM") return false;
  if (market.status !== "open")                       return false;
  const p = market.outcome1Price;
  if (p == null || p < MIN_PRICE || p > MAX_PRICE)   return false;
  if ((event.totalOrders || 0) < MIN_ORDERS)          return false;
  return true;
}

// Edge score — how far is market price from 50/50?
// Higher edge = market has a clear lean we can trade against or with
function edgeScore(market, signalDirection) {
  const p   = market.outcome1Price || 0.5;
  const yes = signalDirection === "YES" || signalDirection === "UP";

  // If signal says YES and market price is low (e.g. 30¢), high edge — market undervalues YES
  // If signal says YES and market price is high (e.g. 70¢), low edge — market already priced in
  const edge = yes ? (0.5 - p) : (p - 0.5);
  return Math.max(0, edge); // only positive edge
}

export async function findMarket(pubKey, preferred = null, excluded = new Set(), strictCategory = false, signalDirection = "UP") {
  const now = Date.now();

  if (!eventCache.data || now - eventCache.ts > CACHE_TTL) {
    const categories = ["crypto", "sports", "finance", "politics", "entertainment"];
    const results    = await Promise.all(
      categories.map(c =>
        getEvents(pubKey, { category: c, size: 50, currency: "NGN" }).catch(() => [])
      )
    );

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

  // Build pool
  let pool = preferred
    ? events.filter(e => e._category === preferred || e.category === preferred)
    : events;

  if (strictCategory && preferred && pool.length === 0) {
    console.log(`[Scorer] No events in "${preferred}" — not falling back`);
    return null;
  }

  if (!strictCategory && preferred && pool.length === 0) {
    pool = events;
  }

  // Score all candidates by edge — pick highest edge market
  const candidates = [];

  for (const event of pool) {
    if (excluded.has(event.id)) continue;
    const market = (event.markets || []).find(m => isTradeable(event, m));
    if (!market) continue;

    const edge = edgeScore(market, signalDirection);
    candidates.push({ event, market, edge });
  }

  if (!candidates.length) {
    console.log(`[Scorer] No tradeable market (preferred: ${preferred || "all"})`);
    return null;
  }

  // Sort by edge descending — highest edge first
  candidates.sort((a, b) => b.edge - a.edge);
  const best = candidates[0];

  console.log(
    `[Scorer] Selected "${best.event.title}" | ` +
    `cat:${best.event._category} | ` +
    `p:${best.market.outcome1Price} | ` +
    `edge:${best.edge.toFixed(3)} | ` +
    `orders:${best.event.totalOrders || 0}`
  );

  return { event: best.event, market: best.market, edge: best.edge };
}
