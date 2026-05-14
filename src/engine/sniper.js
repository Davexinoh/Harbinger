// Harbinger Sniper Engine
// Watches ONLY short-term BTC 15-min markets on Bayse
// Fires the moment a NEW market opens — before crowd prices it
// Target: entry at 30¢-50¢ on fresh markets (highest payout potential)
// Runs every 15 seconds independently of the main engine

import fetch from "node-fetch";
import { executeTrade }  from "./executor.js";
import { getActiveUsers, getOpenEventIds, getUser } from "../db/database.js";
import { decrypt }       from "../utils/encryption.js";
import { sendTradeExecuted, sendTradeFailed } from "../bot/alerts.js";
import { runAllSignals } from "../signals/index.js";
import { lastTradeTimes } from "./engineLoop.js";

const SNIPER_TICK_MS   = 15_000; // check every 15 seconds
const MIN_TRADE_GAP_MS = 5 * 60 * 1000;
const SNIPER_MAX_PRICE = 0.55; // only enter if price is below 55¢ — fresh market
const SNIPER_MIN_SCORE = 0.52; // btc15m signal minimum to fire

// Track markets we've already sniped — don't re-enter same market
const sniped = new Set();

let timer   = null;
let running = false;

// Keywords for short-term binary markets worth sniping
const SNIPER_KEYWORDS = [
  "bitcoin up or down",
  "btc up or down",
  "15 minute",
  "15min",
  "next hour",
  "1 hour",
];

function isSniperMarket(event) {
  const t = (event.title || "").toLowerCase();

  const isBTC =
    t.includes("bitcoin") ||
    t.includes("btc");

  const isShortTerm =
    t.includes("15 minute") ||
    t.includes("15min") ||
    t.includes("next hour") ||
    t.includes("1 hour");

  return isBTC && isShortTerm;
}


async function fetchSniperMarkets(pubKey) {
  try {
    const res = await fetch(
      `https://relay.bayse.markets/v1/pm/events?category=crypto&status=open&size=50&currency=NGN`,
      { headers: { "X-Public-Key": pubKey } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.events || []).filter(e =>
      e.engine !== "AMM" &&
      isSniperMarket(e) &&
      e.markets?.some(m => m.status === "open")
    );
  } catch {
    return [];
  }
}

export function startSniper() {
  if (running) return;
  running = true;
  console.log("[Sniper] Started — scanning every 15s");
  sniperTick();
  timer = setInterval(sniperTick, SNIPER_TICK_MS);
}

export function stopSniper() {
  clearInterval(timer);
  running = false;
}

async function sniperTick() {
  try {
    const users = await getActiveUsers();
    if (!users.length) return;

    const pubKey  = decrypt(users[0].bayse_pub_key)?.trim();
    const events  = await fetchSniperMarkets(pubKey);
    if (!events.length) return;

    // Find fresh markets not yet sniped
    const targets = [];
    for (const event of events) {
      const market = event.markets.find(m =>
        m.status === "open" && isFreshMarket(m) && !sniped.has(m.id)
      );
      if (market) targets.push({ event, market });
    }

    if (!targets.length) return;

    // Get BTC signal — sniper only fires on strong directional signal
    const signals = await runAllSignals(pubKey);
    const btcScore = signals.btc15m?.score || 0.5;
    const btcDir   = signals.btc15m?.direction;

    if (btcScore < SNIPER_MIN_SCORE || !btcDir) {
      console.log(`[Sniper] Signal too weak (btc15m:${btcScore.toFixed(2)}) — holding`);
      return;
    }

    console.log(
      `[Sniper] 🎯 ${targets.length} fresh market(s) | ` +
      `btc15m:${btcScore.toFixed(2)} ${btcDir} | firing`
    );

    // Fire for each active user
    for (const user of users) {
      for (const { event, market } of targets) {
        // Skip if user already has open trade on this event
        const excluded = await getOpenEventIds(user.chat_id);
        if (excluded.has(event.id)) continue;

        // Skip if user is in cooldown
        const lastTrade = lastTradeTimes.get(user.chat_id) || 0;
        if (Date.now() - lastTrade < MIN_TRADE_GAP_MS) continue;

        const fresh = await getUser(user.chat_id);
        if (!fresh?.engine_active) continue;

        try {
          // Build sniper match object
          const direction = btcDir === "UP" ? "YES" : "NO";
          const match = { event, market, direction, edge: 0.5 - (market.outcome1Price || 0.5) };

          const result = await executeTrade(fresh, match, {
            ...signals,
            composite: btcScore, // use btc signal as confidence
          });

          // Mark market as sniped — don't re-enter
          sniped.add(market.id);
          lastTradeTimes.set(user.chat_id, Date.now());

          await sendTradeExecuted(fresh.chat_id, {
            title:        `🎯 SNIPE: ${event.title}`,
            direction:    result.direction,
            amount:       result.amount,
            outcomeLabel: result.outcomeLabel,
            composite:    btcScore,
          });

          console.log(`[Sniper] ✓ ${user.chat_id} | ${event.title} | ${direction} | ₦${result.amount}`);

        } catch (err) {
          console.error(`[Sniper] ${user.chat_id} failed:`, err.message);
          await sendTradeFailed(user.chat_id, {
            composite: btcScore,
            error:     `Sniper: ${err.message}`,
          }).catch(() => {});
        }
      }
    }

    // Clean up old sniped IDs after 2 hours to prevent memory growth
    if (sniped.size > 200) sniped.clear();

  } catch (err) {
    console.error("[Sniper] Tick error:", err.message);
  }
}
