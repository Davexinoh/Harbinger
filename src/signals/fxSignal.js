import fetch from "node-fetch";

const SOURCES = [
  "https://api.frankfurter.app/latest?from=USD&to=NGN,EUR,GBP",
  "https://open.er-api.com/v6/latest/USD",
];

let prevRates  = null;
let currRates  = null;
let cacheTime  = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

async function fetchRates() {
  const now = Date.now();
  if (currRates && now - cacheTime < CACHE_TTL_MS) return currRates;

  for (const url of SOURCES) {
    try {
      const res  = await fetch(url, { timeout: 8000 });
      const data = await res.json();
      const rates = data?.rates
        ? { NGN: data.rates.NGN, EUR: data.rates.EUR, GBP: data.rates.GBP }
        : null;

      if (rates?.NGN) {
        prevRates = currRates;
        currRates = rates;
        cacheTime = now;
        console.log(`[FXSignal] Rates: NGN=${rates.NGN} EUR=${rates.EUR} GBP=${rates.GBP}`);
        return rates;
      }
    } catch (err) {
      console.warn(`[FXSignal] Source failed: ${err.message}`);
    }
  }
  throw new Error("All FX sources failed");
}

export async function runFXSignal() {
  try {
    const rates = await fetchRates();

    // First run — no previous to compare, return neutral 0.50 (not dragging composite)
    if (!prevRates) {
      return {
        source:     "fx",
        score:      0.50,
        direction:  null,
        reason:     "Warming up",
        keywords:   ["forex","fx","naira","ngn","dollar","usd","exchange","rate"],
        fetched_at: new Date().toISOString(),
      };
    }

    // Score based on NGN movement (most relevant for Bayse users)
    const ngnChange = ((rates.NGN - prevRates.NGN) / prevRates.NGN) * 100;
    const eurChange = ((rates.EUR - prevRates.EUR) / prevRates.EUR) * 100;
    const gbpChange = ((rates.GBP - prevRates.GBP) / prevRates.GBP) * 100;

    // NGN weakening (USD/NGN up) = bearish for naira markets
    // Small changes = neutral score near 0.5
    const ngnScore = 0.50 + Math.min(Math.abs(ngnChange) * 10, 0.45) * (ngnChange < 0 ? 1 : -1);
    const fxScore  = Math.min(Math.max((ngnScore + 0.50) / 2, 0.30), 0.80);

    const direction = ngnChange < 0 ? "bullish" : "bearish";

    const best = {
      label:  "USD/NGN",
      change: ngnChange.toFixed(4),
      rate:   rates.NGN,
      score:  fxScore,
      direction,
    };

    console.log(`[FXSignal] NGN change: ${ngnChange.toFixed(4)}% | score: ${fxScore.toFixed(3)} | ${direction}`);

    return {
      source:    "fx",
      score:     fxScore,
      direction,
      best,
      keywords:  ["forex","fx","naira","ngn","dollar","usd","exchange","rate","currency"],
      fetched_at: new Date().toISOString(),
    };
  } catch (err) {
    console.error("[FXSignal] Error:", err.message);
    // Return neutral 0.50 on error — don't drag composite down
    return {
      source:     "fx",
      score:      0.50,
      direction:  null,
      error:      err.message,
      fetched_at: new Date().toISOString(),
    };
  }
}
