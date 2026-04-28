import fetch from "node-fetch";

// Dedicated BTC 15-minute precision signal
// Uses Binance 15m klines for RSI, momentum, and volatility scoring
// Specifically tuned for Bayse "Will BTC go UP/DOWN in 15 mins?" markets

const BINANCE_BASE = "https://api.binance.com/api/v3";
const SYMBOL       = "BTCUSDT";

let cache     = null;
let cacheTime = 0;
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 min — refresh often for 15m markets

async function fetchKlines(interval, limit) {
  const url = `${BINANCE_BASE}/klines?symbol=${SYMBOL}&interval=${interval}&limit=${limit}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines ${res.status}`);
  return res.json();
}

// RSI calculation
function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains  += diff;
    else          losses -= diff;
  }
  const avgGain = gains  / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ATR — measures volatility
function calculateATR(klines, period = 14) {
  const trs = klines.slice(-period).map(k => {
    const high  = parseFloat(k[2]);
    const low   = parseFloat(k[3]);
    const close = parseFloat(k[4]);
    return Math.max(high - low, Math.abs(high - close), Math.abs(low - close));
  });
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

export async function runBTCSignal() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL_MS) return cache;

  try {
    // Fetch 15m and 1m klines in parallel
    const [klines15m, klines1m] = await Promise.all([
      fetchKlines("15m", 50),
      fetchKlines("1m",  30),
    ]);

    const closes15m = klines15m.map(k => parseFloat(k[4]));
    const closes1m  = klines1m.map(k  => parseFloat(k[4]));
    const volumes   = klines15m.map(k => parseFloat(k[5]));

    const currentPrice = closes15m[closes15m.length - 1];
    const prevPrice15m = closes15m[closes15m.length - 2];
    const change15m    = ((currentPrice - prevPrice15m) / prevPrice15m) * 100;

    // 1-min micro momentum (last 5 mins)
    const recentClose  = closes1m[closes1m.length - 1];
    const close5minAgo = closes1m[closes1m.length - 6] || closes1m[0];
    const change1m     = ((recentClose - close5minAgo) / close5minAgo) * 100;

    // RSI on 15m
    const rsi = calculateRSI(closes15m);

    // ATR for volatility context
    const atr     = calculateATR(klines15m);
    const atrPct  = (atr / currentPrice) * 100;

    // Volume trend — is current volume above average?
    const avgVol   = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const currVol  = volumes[volumes.length - 1];
    const volRatio = currVol / avgVol;

    // Score components:
    // 1. Momentum score — combines 15m and 1m changes
    const momentumRaw   = change15m * 0.55 + change1m * 0.45;
    const momentumScore = 1 / (1 + Math.exp(-momentumRaw * 1.5)); // sigmoid, steeper than normal

    // 2. RSI confirmation — RSI >55 bullish, <45 bearish, extremes (>75 or <25) mean reversal likely
    let rsiScore = 0.5;
    if (rsi > 55 && rsi < 75)  rsiScore = 0.7 + (rsi - 55) / 100;
    if (rsi < 45 && rsi > 25)  rsiScore = 0.3 - (45 - rsi) / 100;
    if (rsi >= 75)              rsiScore = 0.35; // overbought — might reverse
    if (rsi <= 25)              rsiScore = 0.65; // oversold — might bounce

    // 3. Volume confirmation — high volume validates the move
    const volumeScore = Math.min(volRatio / 3, 1) * 0.2 + 0.8; // 0.8-1.0 range

    // 4. Volatility filter — very high ATR means unpredictable (lower confidence)
    const volatilityPenalty = atrPct > 1.5 ? 0.15 : 0;

    // Combined score
    const rawScore = (momentumScore * 0.55 + rsiScore * 0.30 + volumeScore * 0.15) - volatilityPenalty;
    const score    = Math.min(Math.max(rawScore, 0), 1);

    // Direction — combine momentum and RSI signals
    const momentumUp = momentumRaw > 0;
    const rsiUp      = rsi > 50 && rsi < 75;
    const direction  = (momentumUp && rsiUp) || (momentumUp && rsi <= 25)
      ? "UP" : "DOWN";

    const result = {
      source:       "btc_15m",
      score,
      direction,
      currentPrice,
      change15m:    change15m.toFixed(3),
      change1m:     change1m.toFixed(3),
      rsi:          rsi.toFixed(1),
      atrPct:       atrPct.toFixed(3),
      volRatio:     volRatio.toFixed(2),
      keywords:     ["bitcoin", "btc", "15", "minutes", "price", "up", "down"],
      fetched_at:   new Date().toISOString(),
    };

    cache     = result;
    cacheTime = now;

    console.log(
      `[BTC15m] score:${score.toFixed(3)} ${direction} | ` +
      `15m:${change15m.toFixed(3)}% 1m:${change1m.toFixed(3)}% | ` +
      `RSI:${rsi.toFixed(1)} vol:${volRatio.toFixed(2)}x`
    );

    return result;
  } catch (err) {
    console.error("[BTC15m] Error:", err.message);
    return {
      source:     "btc_15m",
      score:      0,
      direction:  null,
      error:      err.message,
      fetched_at: new Date().toISOString(),
    };
  }
}
