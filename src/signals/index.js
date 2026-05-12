import fetch from "node-fetch";

const BINANCE = "https://api.binance.com/api/v3";

function clamp(v) { return Math.max(0, Math.min(1, v)); }
function sigmoid(x, k = 2) { return 1 / (1 + Math.exp(-k * x)); }

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  const ag = g / period, al = l / period;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

async function binanceKlines(symbol, interval, limit) {
  const res = await fetch(`${BINANCE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!res.ok) throw new Error(`Binance ${res.status}`);
  return res.json();
}

async function binanceTicker(symbols) {
  const q   = encodeURIComponent(JSON.stringify(symbols));
  const res = await fetch(`${BINANCE}/ticker/24hr?symbols=${q}`);
  if (!res.ok) throw new Error(`Binance ticker ${res.status}`);
  return res.json();
}

// ─── 1. Crypto momentum — multi-timeframe consensus ───────────────────────────
// Looks at 1h, 4h, 24h momentum across BTC, ETH, SOL
// Only bullish when multiple timeframes agree
async function cryptoSignal() {
  const symbols  = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  const tickers  = await binanceTicker(symbols);

  // Get 1h change for each via klines
  const klineResults = await Promise.all(
    symbols.map(s => binanceKlines(s, "1h", 3).catch(() => null))
  );

  let bullVotes = 0, bearVotes = 0;
  const details = [];

  tickers.forEach((t, i) => {
    const chg24 = parseFloat(t.priceChangePercent) || 0;
    const klines = klineResults[i];
    const chg1h  = klines
      ? (parseFloat(klines[2]?.[4]) - parseFloat(klines[0]?.[4])) / parseFloat(klines[0]?.[4]) * 100
      : 0;

    // Consensus: both 1h and 24h must agree
    const bullish = chg1h > 0.1 && chg24 > 0;
    const bearish  = chg1h < -0.1 && chg24 < 0;

    if (bullish) bullVotes++;
    else if (bearish) bearVotes++;

    details.push({ symbol: t.symbol, chg1h: chg1h.toFixed(2), chg24: chg24.toFixed(2) });
  });

  const total     = symbols.length;
  const agreement = Math.max(bullVotes, bearVotes) / total;
  const direction = bullVotes >= bearVotes ? "UP" : "DOWN";

  // Score requires majority agreement — partial agreement = closer to neutral
  const score = clamp(0.5 + (bullVotes - bearVotes) / total * 0.4);

  return {
    score,
    direction,
    agreement: bullVotes >= bearVotes ? bullVotes : bearVotes,
    label: `Crypto ${bullVotes}↑/${bearVotes}↓ of ${total}`,
    details,
  };
}

// ─── 2. BTC 15m — RSI zones + momentum + volume ───────────────────────────────
// Oversold RSI (<35) with upward price = strong UP
// Overbought RSI (>65) with downward price = strong DOWN
// Mid RSI with trend = moderate signal
async function btc15mSignal() {
  const klines = await binanceKlines("BTCUSDT", "15m", 30);
  const closes = klines.map(k => parseFloat(k[4]));
  const highs  = klines.map(k => parseFloat(k[2]));
  const lows   = klines.map(k => parseFloat(k[3]));
  const vols   = klines.map(k => parseFloat(k[5]));

  const r      = rsi(closes, 14);
  const last   = closes[closes.length - 1];
  const prev5  = closes[closes.length - 5];
  const chg5   = (last - prev5) / prev5 * 100;

  // Volume confirmation
  const avgVol = vols.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const curVol = vols[vols.length - 1];
  const volOk  = curVol > avgVol * 0.8;

  // RSI zones
  let rsiSignal = 0.5;
  let direction = "UP";

  if (r < 35 && chg5 > 0) {
    // Oversold bounce — strong UP
    rsiSignal = clamp(0.75 + (35 - r) / 100);
    direction = "UP";
  } else if (r > 65 && chg5 < 0) {
    // Overbought reversal — strong DOWN
    rsiSignal = clamp(0.25 - (r - 65) / 100);
    direction = "DOWN";
  } else if (r >= 35 && r <= 65) {
    // Mid zone — follow momentum
    rsiSignal = clamp(sigmoid(chg5 * 1.2));
    direction = chg5 > 0 ? "UP" : "DOWN";
  } else {
    // RSI extreme without confirmation — reduce confidence
    rsiSignal = 0.5;
    direction = chg5 > 0 ? "UP" : "DOWN";
  }

  const score = clamp(rsiSignal * (volOk ? 1.0 : 0.85));

  return {
    score,
    direction,
    rsi:   r.toFixed(1),
    chg5:  chg5.toFixed(3),
    volOk,
    label: `BTC15m RSI:${r.toFixed(0)} 5c:${chg5.toFixed(2)}% vol:${volOk ? "✓" : "✗"}`,
  };
}

// ─── 3. Sentiment — weighted RSS with recency bias ────────────────────────────
const RSS_FEEDS = [
  { url: "https://coindesk.com/arc/outboundfeeds/rss/",         weight: 2 },
  { url: "https://nairametrics.com/feed/",                       weight: 1.5 },
  { url: "https://feeds.bbci.co.uk/sport/africa/rss.xml",       weight: 1 },
  { url: "https://cointelegraph.com/rss",                        weight: 2 },
];

const POS_WORDS = ["surge","gain","rise","bull","rally","breakout","growth","record","beat","win","positive","high","pump","recover","bounce"];
const NEG_WORDS = ["crash","drop","fall","bear","loss","fail","miss","debt","dump","negative","low","plunge","risk","warn","concern"];

async function sentimentSignal() {
  let weightedPos = 0, weightedNeg = 0, totalWeight = 0;

  await Promise.all(RSS_FEEDS.map(async ({ url, weight }) => {
    try {
      const res    = await fetch(url, { signal: AbortSignal.timeout(4000) });
      const txt    = await res.text();
      const titles = [...txt.matchAll(/<title>(.*?)<\/title>/gi)].map(m => m[1].toLowerCase());

      for (const t of titles) {
        const p = POS_WORDS.filter(w => t.includes(w)).length;
        const n = NEG_WORDS.filter(w => t.includes(w)).length;
        if (p > n) weightedPos += weight;
        else if (n > p) weightedNeg += weight;
        totalWeight += weight;
      }
    } catch {}
  }));

  if (totalWeight === 0) return { score: 0.5, direction: null, label: "No feeds" };

  const score = clamp(0.5 + (weightedPos - weightedNeg) / (totalWeight * 2));
  return {
    score,
    direction: score > 0.52 ? "UP" : score < 0.48 ? "DOWN" : null,
    label: `Sentiment ${weightedPos.toFixed(1)}pos/${weightedNeg.toFixed(1)}neg`,
  };
}

// ─── 4. Market pressure — Bayse order flow ───────────────────────────────────
// Replaces sports signal — looks at crypto markets on Bayse
// High YES buy pressure vs NO = bullish market sentiment
async function marketPressureSignal(pubKey) {
  if (!pubKey) return { score: 0.5, direction: null, label: "No key" };

  try {
    const res = await fetch(
      `https://relay.bayse.markets/v1/pm/events?category=crypto&status=open&size=20&currency=NGN`,
      { headers: { "X-Public-Key": pubKey } }
    );
    if (!res.ok) return { score: 0.5, direction: null, label: "Bayse fallback" };

    const data   = await res.json();
    const events = (data?.events || []).filter(e =>
      e.engine !== "AMM" && e.markets?.some(m => m.status === "open")
    );

    if (!events.length) return { score: 0.5, direction: null, label: "No crypto markets" };

    let totalYesPressure = 0, totalNoPressure = 0, count = 0;

    for (const e of events.slice(0, 10)) {
      const m = e.markets?.find(mk => mk.status === "open");
      if (!m) continue;
      const p = m.outcome1Price || 0.5;
      // Market price IS the crowd's probability estimate
      // Price > 0.5 means crowd is leaning YES
      totalYesPressure += p;
      totalNoPressure  += (1 - p);
      count++;
    }

    if (count === 0) return { score: 0.5, direction: null, label: "No pressure data" };

    const avgYes  = totalYesPressure / count;
    const score   = clamp(avgYes * 0.6 + 0.2); // normalize to reasonable range
    const direction = avgYes > 0.5 ? "UP" : "DOWN";

    return {
      score,
      direction,
      avgYes: avgYes.toFixed(3),
      label: `Market pressure YES:${(avgYes * 100).toFixed(0)}%`,
    };
  } catch (err) {
    return { score: 0.5, direction: null, label: `Pressure error: ${err.message}` };
  }
}

// ─── Signal agreement check ───────────────────────────────────────────────────
// Returns how many signals agree on direction
function getAgreement(signals, direction) {
  const dirs = [signals.crypto, signals.btc15m, signals.sentiment, signals.pressure]
    .map(s => s.direction)
    .filter(Boolean);

  const target = direction === "UP" ? ["UP", "YES", "BULLISH"] : ["DOWN", "NO", "BEARISH"];
  return dirs.filter(d => target.includes(d.toUpperCase())).length;
}

// ─── Composite ────────────────────────────────────────────────────────────────
const WEIGHTS = {
  crypto:   0.35,
  btc15m:   0.30,
  sentiment: 0.15,
  pressure:  0.20,
};

export async function runAllSignals(pubKey) {
  const neutral = { score: 0.5, direction: null, label: "error" };

  const [crypto, btc15m, sentiment, pressure] = await Promise.all([
    cryptoSignal().catch(() => neutral),
    btc15mSignal().catch(() => neutral),
    sentimentSignal().catch(() => neutral),
    marketPressureSignal(pubKey).catch(() => neutral),
  ]);

  const raw =
    crypto.score    * WEIGHTS.crypto    +
    btc15m.score    * WEIGHTS.btc15m    +
    sentiment.score * WEIGHTS.sentiment +
    pressure.score  * WEIGHTS.pressure;

  // Direction vote
  const upVotes   = [crypto, btc15m, sentiment, pressure].filter(s => ["UP","YES"].includes(s.direction?.toUpperCase())).length;
  const downVotes = [crypto, btc15m, sentiment, pressure].filter(s => ["DOWN","NO"].includes(s.direction?.toUpperCase())).length;
  const direction = upVotes >= downVotes ? "UP" : "DOWN";
  const agreement = Math.max(upVotes, downVotes); // 0-4

  // Penalty if signals disagree — reduces composite toward neutral
  // Full agreement (4/4) = no penalty
  // 2/4 agreement = 15% penalty toward neutral
  const agreementRatio = agreement / 4;
  const composite = clamp(raw * agreementRatio + 0.5 * (1 - agreementRatio));

  console.log(
    `[Signals] crypto:${crypto.score.toFixed(2)} btc15m:${btc15m.score.toFixed(2)} ` +
    `sentiment:${sentiment.score.toFixed(2)} pressure:${pressure.score.toFixed(2)} ` +
    `→ raw:${raw.toFixed(2)} agreement:${agreement}/4 → composite:${composite.toFixed(2)}`
  );

  return { crypto, btc15m, sentiment, pressure, composite, direction, agreement };
}
