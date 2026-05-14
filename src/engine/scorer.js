import { getEvents } from "../bayse/client.js";

const CACHE_TTL  = 2 * 60 * 1000;
const MIN_PRICE  = 0.10;
const MAX_PRICE  = 0.90;
const MIN_EDGE   = 0.05; // minimum edge to enter — no overpriced trades

let eventCache = { data: null, ts: 0 };

function isTradeable(event, market) {
  if ((event.engine  || "").toUpperCase() === "AMM") return false;
  if ((market.engine || "").toUpperCase() === "AMM") return false;
  if (market.status !== "open")                       return false;
  const p = market.outcome1Price;
  if (p == null || p < MIN_PRICE || p > MAX_PRICE)   return false;
  return true;
}

// Pick the side with real edge based on signal direction
// Signal says UP + market prices YES at 30¢ = high edge (market undervalues UP)
// Signal says UP + market prices YES at 85¢ = negative edge (market overvalues UP)
function getBestSide(market, signalDirection) {
  const p1     = market.outcome1Price || 0.5;
  const p2     = 1 - p1;
  const signalUp = signalDirection === "UP" || signalDirection === "YES";

  const edge1 = signalUp  ? (0.5 - p1) : (p1 - 0.5); // edge buying outcome1
  const edge2 = !signalUp ? (0.5 - p2) : (p2 - 0.5); // edge buying outcome2

  if (Math.max(edge1, 0) >= Math.max(edge2, 0)) {
    return { edge: Math.max(edge1, 0), direction: "YES" };
  } else {
    return { edge: Math.max(edge2, 0), direction: "NO" };
  }
}

// BTC short-term markets get sniper priority bonus
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

  // Case-insensitive category filter
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

  // Score all candidates
  const candidates = [];

  for (const event of pool) {
    if (excluded.has(event.id)) continue;
    const market = (event.markets || []).find(m => isTradeable(event, m));
    if (!market) continue;

    const { edge, direction } = getBestSide(market, signalDirection);
    const sniperBonus = isBTCSniper(event) ? 0.10 : 0;

    candidates.push({
      event,
      market,
      edge:      edge + sniperBonus,
      rawEdge:   edge,
      direction,
      isSniper:  sniperBonus > 0,
    });
  }

  if (!candidates.length) {
    console.log(`[Scorer] No tradeable market (preferred: ${preferred || "all"})`);
    return null;
  }

  // Sort by edge
  candidates.sort((a, b) => b.edge - a.edge);

  // Hard filter — only enter if real edge exists
  // No positive edge = market is fairly or over-priced for our signal = skip
  const valid = candidates.filter(c => c.rawEdge >= MIN_EDGE);

  if (!valid.length) {
    console.log(
      `[Scorer] No positive-edge market found — best was ` +
      `"${candidates[0].event.title}" rawEdge:${candidates[0].rawEdge.toFixed(3)} — skipping`
    );
    return null;
  }

  const best = valid[0];

  console.log(
    `[Scorer] Selected "${best.event.title}" | ` +
    `cat:${best.event._category} | ` +
    `p:${best.market.outcome1Price} | ` +
    `edge:${best.rawEdge.toFixed(3)} | ` +
    `dir:${best.direction}` +
    (best.isSniper ? " | 🎯 SNIPER" : "")
  );

  return {
    event:     best.event,
    market:    best.market,
    edge:      best.edge,
    direction: best.direction,
  };
}
