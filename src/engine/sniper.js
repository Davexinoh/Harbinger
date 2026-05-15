// Harbinger Sniper — BTC 15m markets ONLY
// Scans every 10 seconds for fresh "Bitcoin Up or Down - 15 minutes?" markets
// Fires immediately when market opens near 50¢ and BTC signal is directional
// Target: catch market before crowd moves price away from 50¢

import fetch from "node-fetch";
import { executeTrade }    from "./executor.js";
import { getActiveUsers, getOpenEventIds, getUser } from "../db/database.js";
import { decrypt }         from "../utils/encryption.js";
import { sendTradeExecuted, sendTradeFailed } from "../bot/alerts.js";
import { runBTC15mSignal } from "../signals/btc15m.js";
import { lastTradeTimes }  from "./engineLoop.js";

const SNIPER_TICK_MS   = 10_000;  // 10 seconds
const MIN_TRADE_GAP_MS = 5 * 60 * 1000;
const FRESH_MAX_PRICE  = 0.58;    // market still "fresh" — hasn't moved far from 50¢
const FRESH_MIN_PRICE  = 0.42;
const MIN_BTC_SCORE    = 0.54;    // minimum BTC signal strength to fire

const sniped  = new Set(); // markets already traded this session
let   timer   = null;
let   running = false;

// Only these exact BTC market titles
const BTC_TITLE_MATCH = "bitcoin up or down";

async function fetchBTCMarkets(pubKey) {
  try {
    const res = await fetch(
      https://relay.bayse.markets/v1/pm/events?category=crypto&status=open&size=30&currency=NGN,
      { headers: { "X-Public-Key": pubKey } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.events || []).filter(e => {
      const title = (e.title || "").toLowerCase();
      return (
        title.includes(BTC_TITLE_MATCH) &&
        e.engine !== "AMM" &&
        e.markets?.some(m => m.status === "open")
      );
    });
  } catch {
    return [];
  }
}

function isFresh(market) {
  const p = market.outcome1Price || 0.5;
  return p >= FRESH_MIN_PRICE && p <= FRESH_MAX_PRICE;
}

export function startSniper() {
  if (running) return;
  running = true;
  console.log("[Sniper] Started — BTC 15m only, scanning every 10s");
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
    const events = await fetchBTCMarkets(pubKey);
    if (!events.length) return;

    // Find fresh markets not yet sniped
    const targets = [];
    for (const event of events) {
      const market = event.markets.find(m =>
        m.status === "open" &&
        isFresh(m) &&
        !sniped.has(m.id)
      );
      if (market) targets.push({ event, market });
    }

    if (!targets.length) return;

    // Get BTC 15m signal — the only signal that matters for this market
    let btcSignal;
    try {
      btcSignal = await runBTC15mSignal();
    } catch {
      return;
    }

    const score = btcSignal?.score || 0.5;
    const dir   = btcSignal?.direction;

    if (score < MIN_BTC_SCORE || !dir) {
      console.log([Sniper] BTC signal weak (${score.toFixed(2)}) — holding);
      return;
    }

    console.log(
      [Sniper] 🎯 ${targets.length} fresh BTC market(s) |  +
      btc15m:${score.toFixed(2)} ${dir} | firing for ${users.length} users
    );

    for (const user of users) {
      for (const { event, market } of targets) {
        const excluded = await getOpenEventIds(user.chat_id);
        if (excluded.has(event.id)) continue;

        const lastTrade = lastTradeTimes.get(user.chat_id) || 0;
        if (Date.now() - lastTrade < MIN_TRADE_GAP_MS) continue;

        const fresh = await getUser(user.chat_id);
        if (!fresh?.engine_active) continue;

        try {
          const direction = dir === "UP" ? "YES" : "NO";
          const match = {
            event,
            market,
            direction,
            edge: Math.abs((market.outcome1Price || 0.5) - 0.5),
          };// Build minimal signals object for executor
          const signals = {
            composite: score,
            direction,
            btc15m:    btcSignal,
            crypto:    { score: 0.5, direction: null },
            sentiment: { score: 0.5, direction: null },
            pressure:  { score: 0.5, direction: null },
          };

          const result = await executeTrade(fresh, match, signals);

          sniped.add(market.id);
          lastTradeTimes.set(user.chat_id, Date.now());

          await sendTradeExecuted(fresh.chat_id, {
            title:        🎯 SNIPE: ${event.title},
            direction:    result.direction,
            amount:       result.amount,
            outcomeLabel: result.outcomeLabel,
            composite:    score,
          });

          console.log(
            [Sniper] ✓ ${user.chat_id} | ${direction} |  +
            p:${market.outcome1Price} | ₦${result.amount}
          );

        } catch (err) {
          console.error([Sniper] ${user.chat_id} failed:, err.message);
          await sendTradeFailed(user.chat_id, {
            composite: score,
            error:     Sniper: ${err.message},
          }).catch(() => {});
        }
      }
    }

    // Prevent memory leak on long-running instances
    if (sniped.size > 500) sniped.clear();

  } catch (err) {
    console.error("[Sniper] Tick error:", err.message);
  }
}
