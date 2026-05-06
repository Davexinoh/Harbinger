export async function findMatchingMarket(signals, pubKey, excluded = new Set(), preferred = null) {
  let events;
  try {
    events = await fetchEvents(pubKey);
  } catch (err) {
    console.error("[Scorer] fetchEvents failed:", err.message);
    return null;
  }

  const leader = [signals.crypto, signals.sports, signals.btc15m]
    .filter(s => s?.score != null)
    .sort((a, b) => b.score - a.score)[0];

  if (!leader) return null;

  const direction = (leader.direction === "UP" || leader.direction === "bullish")
    ? "YES" : "NO";

  // Try preferred category first, then fall back to all categories
  const allCats   = Object.keys(events);
  const orderedCats = preferred
    ? [preferred, ...allCats.filter(c => c !== preferred)]
    : allCats;

  for (const cat of orderedCats) {
    const pool = (events[cat] || []).filter(e => !excluded.has(e.id));

    for (const event of pool) {
      const market = (event.markets || []).find(m => isTradeable(event, m));
      if (!market) continue;

      console.log(`[Scorer] Selected: "${event.title}" | cat:${cat} | engine:${event.engine || "CLOB"} | p:${market.outcome1Price}`);

      return {
        event,
        market,
        suggestedOutcome: direction,
        signalSource:     leader.source,
        signalScore:      leader.score,
        matchedKeywords:  [],
      };
    }
  }

  console.log("[Scorer] No tradeable CLOB market found this tick");
  return null;
}
