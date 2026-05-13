import { getEvents } from "../bayse/client.js";

const CACHE_TTL = 2 * 60 * 1000; // 2 min — faster refresh for sniper
const MIN_PRICE = 0.10;
const MAX_PRICE = 0.90;

let eventCache = { data: null, ts: 0 };

function isTradeable(event, market) {
  if ((event.engine  || "").toUpperCase() === "AMM") return false;
  if ((market.engine || "").toUpperCase() === "AMM") return false;
  if (market.status !== "open")                       return false;
  const p = market.outcome1Price;
  if (p == null || p < MIN_PRICE || p > MAX_PRICE)   return false;
  return true;
}

// Edge = distance from 0.5 — we trade TOWARD the market lean
// If outcome1Price = 0.3 → market says NO is likely (70¢)
// If outcome1Price = 0.7 → market says YES is likely (70¢)
// Best edge = pick the CHEAP side that our signal agrees with
function getBestSide(market, signalDirection) {
  const p1 = market.outcome1Price || 0.5;
  const p2 = 1 - p1;

  const signalUp = signalDirection === "UP" || signalDirection === "YES";

  // Edge for buying outcome1 (YES side)
  const edge1 = signalUp  ? (0.5 - p1) : (p1 - 0.5);
  // Edge for buying outcome2 (NO side)
  const edge2 = !signalUp ? (0.5 - p2) : (p2 - 0.5);

  if (Math.max(edge1, 0) >= Math.max(edge2, 0)) {
    return {
      edge:      Math.max(edge1, 0),
      direction: "YES",
    };
  } else {
    return {
      edge:      Math.max(edge2, 0),
      direction: "NO",
    };
  }
}

// Check if event is a short-term BTC market — sniper priority
function isBTCSniper(event) {
  const t = (event.title || "").toLowerCase();
  return (t.includes("bitcoin") || t.includes("btc")) &&
    (t.includes("15 min") || t.includes("15min") || t.includes("hour") || t.includes("1h"));
}

export async function findMarket(
  pubKey,
  preferred       = null,
  excluded        = new Set(),
  strictCategory  = false,
  signalDirection = "UP"
) {
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

  let pool = preferred
    ? events.filter(e =>
        e._category?.toLowerCase() === preferred.toLowerCase() ||
        e.category?.toLowerCase()  === preferred.toLowerCase()
      )
    : events;

  if (strictCategory && preferred && pool.length === 0) {
    console.log(`[Scorer] No events in "${preferred}" — not falling back`);
    return null;
  }

  if (!strictCategory && preferred && pool.length === 0) {
    pool = events;
  }

  const candidates = [];

  for (const event of pool) {
    if (excluded.has(event.id)) continue;
    const market = (event.markets || []).find(m => isTradeable(event, m));
    if (!market) continue;

    const { edge, direction } = getBestSide(market, signalDirection);
    const sniper = isBTCSniper(event) ? 0.15 : 0; // bonus for BTC short-term markets

    candidates.push({ event, market, edge: edge + sniper, direction, isSniper: sniper > 0 });
  }

  if (!candidates.length) {
    console.log(`[Scorer] No tradeable market (preferred: ${preferred || "all"})`);
    return null;
  }

  candidates.sort((a, b) => b.edge - a.edge);
  const best = candidates[0];

  console.log(
    `[Scorer] Selected "${best.event.title}" | ` +
    `cat:${best.event._category} | ` +
    `p:${best.market.outcome1Price} | ` +
    `edge:${best.edge.toFixed(3)} | ` +
    `dir:${best.direction}` +
    (best.isSniper ? " | 🎯 SNIPER" : "")
  );

  return {
    event:     best.event,
    market:    best.market,
    edge:      best.edge,
    direction: best.direction, // actual trade direction from edge scoring
  };
}
