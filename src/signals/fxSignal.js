import fetch from "node-fetch";

// Free FX rates — no key needed
// Using exchangerate-api free tier and frankfurter.app as fallback
const PRIMARY_URL  = "https://api.frankfurter.app/latest?from=USD&to=NGN,EUR,GBP";
const FALLBACK_URL = "https://open.er-api.com/v6/latest/USD";

let cache     = null;
let cacheTime = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

// Store previous rates to calculate momentum
let prevRates = null;

async function fetchRates() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL_MS) return cache;

  let rates = null;

  // Try primary source
  try {
    const res  = await fetch(PRIMARY_URL, { timeout: 8000 });
    const data = await res.json();
    if (data?.rates) {
      rates = {
        NGN: data.rates.NGN,
        EUR: data.rates.EUR,
        GBP: data.rates.GBP,
      };
    }
  } catch (err) {
    console.warn("[FXSignal] Primary source failed:", err.message);
  }

  // Fallback
  if (!rates) {
    try {
      const res  = await fetch(FALLBACK_URL, { timeout: 8000 });
      const data = await res.json();
      if (data?.rates) {
        rates = {
          NGN: data.rates.NGN,
          EUR: data.rates.EUR,
          GBP: data.rates.GBP,
        };
      }
    } catch (err) {
      console.warn("[FXSignal] Fallback source failed:", err.message);
    }
  }

  if (!rates) throw new Error("All FX sources failed");

  // Save previous before updating
  if (cache) prevRates = cache.rates;

  cache     = { rates, fetched_at: new Date().toISOString() };
  cacheTime = now;
  return cache;
}

function scorePair(symbol, currentRate, prevRate) {
  if (!prevRate || !currentRate) return { score: 0.5, direction: null, change: 0 };

  // % change since last fetch
  const change = ((currentRate - prevRate) / prevRate) * 100;

  // For NGN — weakening naira (USD/NGN going UP) = bearish for Nigerian economy
  // For EUR/GBP — strengthening vs USD = bullish global sentiment
  const isNGN     = symbol === "NGN";
  const isStrong  = isNGN ? change < 0 : change > 0; // NGN strengthening = rate goes DOWN

  const absChange = Math.abs(change);

  // Score based on magnitude of move
  // 0.5% move = moderate signal, 1%+ = strong signal
  const rawScore  = 0.5 + Math.min(absChange / 2, 0.45);
  const score     = isStrong ? rawScore : 1 - rawScore + 0.5;
  const direction = isStrong ? "bullish" : "bearish";

  return {
    score:  Math.min(Math.max(score, 0), 1),
    direction,
    change: change.toFixed(4),
    rate:   currentRate,
  };
}

export async function runFXSignal() {
  try {
    const current = await fetchRates();

    if (!prevRates) {
      // First run — no previous to compare, return neutral
      return {
        source:     "fx",
        score:      0.45,
        direction:  null,
        reason:     "Warming up — no previous rates yet",
        fetched_at: current.fetched_at,
      };
    }

    const pairs = [
      { symbol: "NGN", label: "USD/NGN" },
      { symbol: "EUR", label: "EUR/USD" },
      { symbol: "GBP", label: "GBP/USD" },
    ];

    const scored = pairs.map(p => ({
      ...p,
      ...scorePair(p.symbol, current.rates[p.symbol], prevRates[p.symbol]),
    })).filter(p => p.score !== 0.5);

    if (!scored.length) {
      return {
        source:     "fx",
        score:      0.45,
        direction:  "neutral",
        reason:     "No significant FX movement",
        fetched_at: current.fetched_at,
      };
    }

    // Highest scoring pair drives the signal
    const best = scored.sort((a, b) => Math.abs(b.score - 0.5) - Math.abs(a.score - 0.5))[0];

    console.log(
      `[FXSignal] Best: ${best.label} | score:${best.score.toFixed(3)} ` +
      `${best.direction} | change:${best.change}%`
    );

    return {
      source:     "fx",
      score:      best.score,
      direction:  best.direction,
      best,
      all:        scored,
      keywords:   ["forex", "fx", "naira", "ngn", "dollar", "usd", "eur", "gbp", "exchange", "rate", "currency"],
      fetched_at: current.fetched_at,
    };
  } catch (err) {
    console.error("[FXSignal] Error:", err.message);
    return {
      source:     "fx",
      score:      0.45,
      direction:  null,
      error:      err.message,
      fetched_at: new Date().toISOString(),
    };
  }
}
