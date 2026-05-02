import { runCryptoSignal }    from "../signals/cryptoSignal.js";
import { runSportsSignal }    from "../signals/sportsSignal.js";
import { runSentimentSignal } from "../signals/sentimentSignal.js";
import { runBTCSignal }       from "../signals/btcSignal.js";
import { getEvents }          from "../bayse/client.js";
import { logSignal }          from "../db/database.js";

// Simplified weights — no FX dragging composite, no crowd
const WEIGHTS = { crypto: 0.40, sports: 0.25, sentiment: 0.20, btc15m: 0.15 };

const ALL_CATEGORIES = ["sports", "crypto", "politics", "entertainment", "finance", null];

let eventsCache     = {};
let eventsCacheTime = 0;
const EVENTS_CACHE_TTL = 5 * 60 * 1000;

export async function runAllSignals(preferredCategory = null) {
  const [crypto, sports, sentiment, btc15m] = await Promise.all([
    runCryptoSignal(),
    runSportsSignal(),
    runSentimentSignal(),
    runBTCSignal(),
  ]);

  const composite =
    crypto.score    * WEIGHTS.crypto    +
    sports.score    * WEIGHTS.sports    +
    sentiment.score * WEIGHTS.sentiment +
    btc15m.score    * WEIGHTS.btc15m;

  Promise.all([
    logSignal("crypto",    crypto.score,    crypto.best    || null),
    logSignal("sports",    sports.score,    sports.best    || null),
    logSignal("sentiment", sentiment.score, sentiment.best || null),
    logSignal("btc_15m",   btc15m.score,    btc15m         || null),
  ]).catch(() => {});

  return { crypto, sports, sentiment, btc15m, composite, computed_at: new Date().toISOString() };
}

async function fetchAllEvents(publicKey) {
  const now = Date.now();
  if (Object.keys(eventsCache).length && now - eventsCacheTime < EVENTS_CACHE_TTL) return eventsCache;

  const results = await Promise.allSettled(
    ALL_CATEGORIES.map(cat => getEvents(publicKey, { category: cat, status: "open", size: 50 }))
  );

  const byCategory = {};
  const seen = new Set();
  ALL_CATEGORIES.forEach((cat, i) => {
    const key = cat || "general";
    byCategory[key] = [];
    if (results[i].status === "fulfilled") {
      for (const event of results[i].value) {
        if (!seen.has(event.id)) { seen.add(event.id); byCategory[key].push(event); }
      }
    }
  });

  eventsCache     = byCategory;
  eventsCacheTime = now;
  return byCategory;
}

export async function findMatchingMarket(signals, publicKey, unsettledEventIds = new Set(), preferredCategory = null) {
  if (!publicKey) return null;
  try {
    const cache    = await fetchAllEvents(publicKey);
    const keywords = buildKeywords(signals);
    const leader   = [signals.crypto, signals.sports, signals.btc15m]
      .reduce((a, b) => a.score > b.score ? a : b);

    const categoryOrder = preferredCategory
      ? [preferredCategory, ...ALL_CATEGORIES.filter(c => c !== preferredCategory && c !== null), null]
      : ALL_CATEGORIES;

    for (const category of categoryOrder) {
      const key  = category || "general";
      const pool = (cache[key] || [])
        .filter(e => !unsettledEventIds.has(e.id))
        .filter(e => (e.markets || []).some(m => m.status === "open"));
      if (!pool.length) continue;

      const scored = pool.map(event => {
        const text = `${(event.title||"").toLowerCase()} ${(event.description||"").toLowerCase()}`;
        let matchScore = 0; const matched = [];
        for (const kw of keywords) { if (text.includes(kw.word)) { matchScore += kw.weight; matched.push(kw.word); } }
        matchScore += Math.min((event.totalOrders||0)/1000, 0.3);
        return { event, matchScore, matched };
      }).sort((a, b) => b.matchScore - a.matchScore);

      for (const candidate of scored.slice(0, 3)) {
        const market = (candidate.event.markets || []).find(m => m.status === "open");
        if (!market) continue;

        const title     = (candidate.event.title || "").toLowerCase();
        const isBtc     = title.includes("bitcoin") || title.includes("btc");
        const useLeader = isBtc && signals.btc15m?.score > 0.45 ? signals.btc15m : leader;
        const dir       = useLeader.direction;
        const suggestedOutcome = dir === "UP" || dir === "bullish" || dir === "YES" ? "YES" : "NO";

        console.log(`[Scorer] ✦ "${candidate.event.title}" [${key}] | ${suggestedOutcome} | ${useLeader.source} ${(useLeader.score*100).toFixed(0)}%`);
        return { event: candidate.event, market, matchedKeywords: candidate.matched.slice(0,3), signalSource: useLeader.source, signalScore: useLeader.score, suggestedOutcome, category: key };
      }
    }
    return null;
  } catch (err) {
    console.error("[Scorer] Error:", err.message);
    return null;
  }
}

function buildKeywords(signals) {
  const kws = []; const add = (w,wt) => { if(w?.length>2) kws.push({word:w.toLowerCase().trim(),weight:wt}); };
  if (signals.crypto?.best) { add(signals.crypto.best.symbol,1.5); add(signals.crypto.best.coinId,1.2); for(const k of signals.crypto.best.keywords||[]) add(k,1.0); add("bitcoin",0.8);add("btc",0.8);add("eth",0.7);add("crypto",0.7); }
  if (signals.btc15m?.score>0.45) { add("bitcoin",1.5);add("btc",1.5);add("15",1.2);add("minutes",1.0);add("up",0.7);add("down",0.7); }
  if (signals.sports?.best) { for(const k of signals.sports.best.keywords||[]) add(k,0.9); add("football",0.6);add("match",0.5); }
  if (signals.sentiment?.best) { const sw=new Set(["the","a","an","in","on","at","to","for","of","and","or","is","are","was","were"]); const ws=(signals.sentiment.best.title||"").toLowerCase().split(/\s+/).filter(w=>w.length>3&&!sw.has(w)); for(const w of ws.slice(0,5)) add(w,0.6); }
  add("ngn",0.7);add("naira",0.8);add("nigeria",0.8);add("election",0.8);add("forex",0.7);
  return kws;
}
