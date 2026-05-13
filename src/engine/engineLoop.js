import { runAllSignals }   from "../signals/index.js";
import { findMarket }      from "./scorer.js";
import { executeTrade }    from "./executor.js";
import { getActiveUsers, getOpenEventIds, getUser } from "../db/database.js";
import { decrypt }         from "../utils/encryption.js";
import { sendTradeExecuted, sendTradeFailed } from "../bot/alerts.js";

const TICK_MS = 30_000; // 30s instead of 60s — sniper speed
const MIN_TRADE_GAP_MS = 5 * 60 * 1000; // 5 min cooldown per user

let timer       = null;
let running     = false;
let activeCount = 0;

const locks          = new Map();
const lastTradeTimes = new Map();

export function startEngine() {
  if (running) return;
  running = true;
  console.log("[Engine] Started — tick every 60s");
  tick();
  timer = setInterval(tick, TICK_MS);
}

export function stopEngine() {
  clearInterval(timer);
  running = false;
}

export function getEngineStatus() {
  return { running, activeUsers: activeCount };
}

async function tick() {
  try {
    const users = await getActiveUsers();
    activeCount = users.length;
    if (!users.length) return;

    const pubKey  = decrypt(users[0].bayse_pub_key)?.trim();
    const signals = await runAllSignals(pubKey);

    console.log(`[Engine] composite=${signals.composite.toFixed(3)} | ${users.length} active users`);

    for (const user of users) {
      if (locks.get(user.chat_id)) continue;
      locks.set(user.chat_id, true);
      processUser(user, signals, pubKey)
        .finally(() => locks.delete(user.chat_id));
    }
  } catch (err) {
    console.error("[Engine] Tick error:", err.message);
  }
}

async function processUser(user, signals, pubKey) {
  try {
    const fresh = await getUser(user.chat_id);
    if (!fresh?.engine_active) return;

    const threshold = parseFloat(fresh.threshold) || 0.6;
    if (signals.composite < threshold) return;

    const lastTrade = lastTradeTimes.get(user.chat_id) || 0;
    if (Date.now() - lastTrade < MIN_TRADE_GAP_MS) {
      console.log(`[Engine] ${user.chat_id} — cooldown active, skipping`);
      return;
    }

    const excluded = await getOpenEventIds(fresh.chat_id);

    const preferred = fresh.preferred_category && fresh.preferred_category !== "all"
      ? fresh.preferred_category
      : null;
// In processUser, update the findMarket call:
const match = await findMarket(pubKey, preferred, excluded, true, signals.direction);
    
    if (!match) {
      console.log(`[Engine] ${user.chat_id} — no market (category: ${preferred || "all"})`);
      return;
    }

    lastTradeTimes.set(user.chat_id, Date.now());

    const result = await executeTrade(fresh, match, signals);

    await sendTradeExecuted(fresh.chat_id, {
      title:        match.event.title,
      direction:    result.direction,
      amount:       result.amount,
      outcomeLabel: result.outcomeLabel,
      composite:    signals.composite,
    });

  } catch (err) {
    console.error(`[Engine] ${user.chat_id} failed:`, err.message);
    await sendTradeFailed(user.chat_id, {
      composite: signals.composite,
      error:     err.message,
    }).catch(() => {});
  }
}
