// Harbinger Sniper Engine (Hardened)
// BTC-only, fresh-market sniper with signal gating + safe execution

import fetch from "node-fetch";
import { executeTrade } from "./executor.js";
import { getActiveUsers, getOpenEventIds, getUser, disableUser } from "../db/database.js";
import { decrypt } from "../utils/encryption.js";
import { sendTradeExecuted, sendTradeFailed } from "../bot/alerts.js";
import { runAllSignals } from "../signals/index.js";
import { lastTradeTimes } from "./engineLoop.js";

const SNIPER_TICK_MS   = 15_000;
const MIN_TRADE_GAP_MS = 5 * 60 * 1000;

const SNIPER_MAX_PRICE = 0.55; // ≤55¢ = early market
const SNIPER_MIN_SCORE = 0.52; // BTC signal threshold

const ONLY_BTC = true;

const sniped = new Set();

let timer   = null;
let running = false;

/* ---------------- HELPERS ---------------- */

const isFreshMarket = (market) => {
  const p = market.outcome1Price ?? 0.5;
  return p >= (1 - SNIPER_MAX_PRICE) && p <= SNIPER_MAX_PRICE;
};

function isBTCEvent(event) {
  const t = (event.title || "").toLowerCase();
  return t.includes("bitcoin") || t.includes("btc");
}

function isShortTerm(event) {
  const t = (event.title || "").toLowerCase();
  return (
    t.includes("15 minute") ||
    t.includes("15min") ||
    t.includes("next hour") ||
    t.includes("1 hour")
  );
}

function isSniperEvent(event) {
  if (ONLY_BTC && !isBTCEvent(event)) return false;
  return isShortTerm(event);
}

/* ---------------- FETCH ---------------- */

async function fetchSniperMarkets(pubKey) {
  try {
    const res = await fetch(
      `https://relay.bayse.markets/v1/pm/events?category=crypto&status=open&size=50&currency=NGN`,
      { headers: { "X-Public-Key": pubKey } }
    );

    if (!res.ok) return [];

    const data = await res.json();

    return (data?.events || []).filter(e => {
      return (
        e.engine !== "AMM" &&
        isSniperEvent(e) &&
        e.markets?.some(m => m.status === "open")
      );
    });

  } catch {
    return [];
  }
}

/* ---------------- CORE ---------------- */

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

    const pubKey = decrypt(users[0].bayse_pub_key)?.trim();
    if (!pubKey) return;

    const events = await fetchSniperMarkets(pubKey);
    if (!events.length) return;

    const targets = [];

    for (const event of events) {
      const market = event.markets.find(m => {
        return (
          m.status === "open" &&
          isFreshMarket(m) &&
          !sniped.has(m.id)
        );
      });

      if (market) targets.push({ event, market });
    }

    if (!targets.length) return;

    console.log(`[Sniper] Found ${targets.length} fresh BTC market(s)`);

    /* -------- SIGNAL GATING -------- */

    const signals  = await runAllSignals(pubKey);
    const btcScore = signals.btc15m?.score || 0.5;
    const btcDir   = signals.btc15m?.direction;

    if (btcScore < SNIPER_MIN_SCORE || !btcDir) {
      console.log(`[Sniper] Signal weak (${btcScore.toFixed(2)}) — skip`);
      return;
    }

    console.log(
      `[Sniper] 🎯 firing | btc15m:${btcScore.toFixed(2)} ${btcDir}`
    );

    /* -------- EXECUTION (PARALLEL USERS) -------- */

    await Promise.all(users.map(async (user) => {
      try {
        const fresh = await getUser(user.chat_id);
        if (!fresh?.engine_active) return;

        const lastTrade = lastTradeTimes.get(user.chat_id) || 0;
        if (Date.now() - lastTrade < MIN_TRADE_GAP_MS) return;

        const excluded = await getOpenEventIds(user.chat_id);

        for (const { event, market } of targets) {
          if (excluded.has(event.id)) continue;

          try {
            const direction = btcDir === "UP" ? "YES" : "NO";

            const match = {
              event,
              market,
              direction,
              edge: 0.5 - (market.outcome1Price ?? 0.5),
            };

            const result = await executeTrade(fresh, match, {
              ...signals,
              composite: btcScore,
            });

            sniped.add(market.id);
            lastTradeTimes.set(user.chat_id, Date.now());

            await sendTradeExecuted(fresh.chat_id, {
              title:        `🎯 BTC SNIPE: ${event.title}`,
              direction:    result.direction,
              amount:       result.amount,
              outcomeLabel: result.outcomeLabel,
              composite:    btcScore,
            });

            console.log(
              `[Sniper] ✓ ${user.chat_id} | BTC | ${direction} | ₦${result.amount}`
            );

          } catch (err) {
            const msg = err.message || "";

            // Kill bad API keys immediately
            if (msg.includes("401")) {
              console.error(`[Sniper] ${user.chat_id} invalid API key — disabling`);
              await disableUser(user.chat_id);
              return;
            }

            console.error(`[Sniper] ${user.chat_id} failed:`, msg);

            await sendTradeFailed(user.chat_id, {
              composite: btcScore,
              error: `Sniper: ${msg}`,
            }).catch(() => {});
          }
        }

      } catch (err) {
        console.error(`[Sniper] user ${user.chat_id} error:`, err.message);
      }
    }));

    /* -------- MEMORY CLEANUP -------- */

    if (sniped.size > 200) sniped.clear();

  } catch (err) {
    console.error("[Sniper] Tick error:", err.message);
  }
}
