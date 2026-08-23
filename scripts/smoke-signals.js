// Smoke-check for Harbinger's four signal sources.
//
// Read-only and side-effect free: it touches no database, starts no Telegram
// bot, and places no orders. Run it after a redeploy, BEFORE enabling any user
// for live trading.
//
//   node scripts/smoke-signals.js [bayse_public_key]
//
// The Bayse public key may also come from BAYSE_PUBLIC_KEY. It is only used for
// read endpoints; the secret key is never needed here. Without it, the market
// pressure probe is reported as SKIP rather than failing the run.
//
// Exit code 0 = every critical source resolved. 1 = at least one failed.

import fetch from "node-fetch";
import { runAllSignals, runBTC15mSignal } from "../src/signals/index.js";

const pubKey = process.argv[2] || process.env.BAYSE_PUBLIC_KEY || "";

const BINANCE = "https://api.binance.com/api/v3";
const BAYSE   = "https://relay.bayse.markets";

// Mirrors RSS_FEEDS in src/signals/index.js, which does not export it. If you
// change the feed list there, change it here too.
const RSS_FEEDS = [
  "https://coindesk.com/arc/outboundfeeds/rss/",
  "https://cointelegraph.com/rss",
  "https://nairametrics.com/feed/",
  "https://feeds.bbci.co.uk/sport/africa/rss.xml",
];

const results = [];

function record(name, ok, detail, { critical = true } = {}) {
  results.push({ name, ok, detail, critical });
  const tag = ok === null ? "SKIP" : ok ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${name.padEnd(34)} ${detail}`);
}

async function timed(fn) {
  const t0 = Date.now();
  const out = await fn();
  return { out, ms: Date.now() - t0 };
}

// ─── Raw endpoint reachability ────────────────────────────────────────────────

async function probeBinance() {
  console.log("\nBinance (public — no API key required)");

  try {
    const { out, ms } = await timed(async () => {
      const q   = encodeURIComponent(JSON.stringify(["BTCUSDT", "ETHUSDT", "SOLUSDT"]));
      const res = await fetch(`${BINANCE}/ticker/24hr?symbols=${q}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    });
    record("ticker/24hr (3 symbols)", out.length === 3, `${out.length}/3 symbols, ${ms}ms`);
  } catch (err) {
    record("ticker/24hr (3 symbols)", false, err.message);
  }

  try {
    const { out, ms } = await timed(async () => {
      const res = await fetch(`${BINANCE}/klines?symbol=BTCUSDT&interval=15m&limit=30`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    });
    // btc15mSignal needs 30 candles for a 14-period RSI plus a 10-candle volume mean.
    record("klines 15m (need 30)", out.length >= 30, `${out.length} candles, ${ms}ms`);
  } catch (err) {
    record("klines 15m (need 30)", false, err.message);
  }
}

async function probeRss() {
  console.log("\nRSS sentiment feeds");

  await Promise.all(RSS_FEEDS.map(async url => {
    const host = new URL(url).host;
    try {
      // signals/index.js uses a 4s timeout, so match it — a feed that only
      // answers in 8s is effectively dead to the engine.
      const { out, ms } = await timed(async () => {
        const res = await fetch(url, { signal: AbortSignal.timeout(4_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      });
      const titles = [...out.matchAll(/<title>(.*?)<\/title>/gi)].length;
      record(host, titles > 1, `${titles} <title> tags, ${ms}ms`, { critical: false });
    } catch (err) {
      record(host, false, err.message, { critical: false });
    }
  }));
}

async function probeBayse() {
  console.log("\nBayse relay (market pressure)");

  if (!pubKey) {
    record("events?category=crypto", null, "no public key supplied — pass as argv[1] or BAYSE_PUBLIC_KEY");
    return;
  }

  try {
    const { out, ms } = await timed(async () => {
      const res = await fetch(
        `${BAYSE}/v1/pm/events?category=crypto&status=open&size=20&currency=NGN`,
        { headers: { "X-Public-Key": pubKey }, signal: AbortSignal.timeout(10_000) }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    });

    const events = out?.events || [];
    // The engine only trades CLOB markets, so an AMM-only response means the
    // pressure signal and the scorer both come up empty.
    const clob = events.filter(e => e.engine !== "AMM" && e.markets?.some(m => m.status === "open"));
    record("events?category=crypto", events.length > 0, `${events.length} events, ${ms}ms`);
    record("open non-AMM (CLOB) markets", clob.length > 0, `${clob.length} tradeable`);

    const btc = events.filter(e => (e.title || "").toLowerCase().includes("bitcoin up or down"));
    record("'bitcoin up or down' (sniper)", btc.length > 0, `${btc.length} found`, { critical: false });
  } catch (err) {
    record("events?category=crypto", false, err.message);
  }
}

// ─── Real code path ───────────────────────────────────────────────────────────

async function probeComposite() {
  console.log("\nComposite via src/signals/index.js");

  try {
    const { out, ms } = await timed(() => runBTC15mSignal());
    record("runBTC15mSignal()", Number.isFinite(out?.score), `score:${out?.score?.toFixed(3)} dir:${out?.direction} ${ms}ms`);
  } catch (err) {
    record("runBTC15mSignal()", false, err.message);
  }

  try {
    const { out, ms } = await timed(() => runAllSignals(pubKey || null));

    // runAllSignals swallows per-source failures and substitutes a neutral
    // 0.5 stub, so a clean return does not mean all four worked. The label is
    // the only way to tell a real reading from a fallback.
    for (const key of ["crypto", "btc15m", "sentiment", "pressure"]) {
      const s     = out[key];
      const label = s?.label ?? "(none)";
      const stubbed = /error|fallback|no feeds|no key|no data|no markets/i.test(label);
      const skip    = key === "pressure" && !pubKey;
      record(
        `  ${key}`,
        skip ? null : !stubbed,
        `score:${s?.score?.toFixed(3)} "${label}"`,
        { critical: !skip }
      );
    }

    record("runAllSignals() composite", Number.isFinite(out?.composite),
      `composite:${out?.composite?.toFixed(3)} dir:${out?.direction} agree:${out?.agreement}/4 ${ms}ms`);
  } catch (err) {
    record("runAllSignals()", false, err.message);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log("Harbinger signal smoke-check");
console.log(pubKey ? "Bayse public key: supplied" : "Bayse public key: MISSING (pressure probes will skip)");

await probeBinance();
await probeRss();
await probeBayse();
await probeComposite();

const failed      = results.filter(r => r.ok === false);
const critFailed  = failed.filter(r => r.critical);
const skipped     = results.filter(r => r.ok === null);

console.log("\n─────────────────────────────────────────────");
console.log(`${results.filter(r => r.ok === true).length} passed, ${failed.length} failed, ${skipped.length} skipped`);

if (failed.filter(r => !r.critical).length) {
  console.log(`\nNon-critical failures (engine degrades to neutral, still trades):`);
  for (const r of failed.filter(r => !r.critical)) console.log(`  - ${r.name}: ${r.detail}`);
}

if (critFailed.length) {
  console.log(`\nCRITICAL failures — do NOT enable live trading:`);
  for (const r of critFailed) console.log(`  - ${r.name}: ${r.detail}`);
  process.exit(1);
}

console.log("\nAll critical signal sources resolved.");
if (skipped.length) console.log("Re-run with a Bayse public key to cover the skipped probes.");
process.exit(0);
