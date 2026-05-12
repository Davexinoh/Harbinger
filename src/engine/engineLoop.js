import { runAllSignals } from "../signals/index.js";
import { findMarket }    from "./scorer.js";
import { executeTrade }  from "./executor.js";
import { getActiveUsers, getOpenEventIds, getUser } from "../db/database.js";
import { decrypt }       from "../utils/encryption.js";
import { sendAlert }     from "../bot/alerts.js";

const TICK_MS          = 60_000;
const MIN_TRADE_GAP_MS = 20 * 60 * 1000; // 20 min cooldown per user

let timer       = null;
let running     = false;
let activeCount = 0;

const locks          = new Map(); // prevent concurrent ticks per user
const lastTradeTimes = new Map(); // in-memory cooldown per user

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

    // Cooldown check — enforce 20 min between trades per user
    const lastTrade = lastTradeTimes.get(user.chat_id) || 0;
    if (Date.now() - lastTrade < MIN_TRADE_GAP_MS) {
      console.log(`[Engine] ${user.chat_id} — cooldown active, skipping`);
      return;
    }

    const excluded = await getOpenEventIds(fresh.chat_id);

    // Strict category — only pass preferred, no fallback to all
    const preferred = fresh.preferred_category && fresh.preferred_category !== "all"
      ? fresh.preferred_category
      : null;

    const match = await findMarket(pubKey, preferred, excluded, true);
    if (!match) {
      console.log(`[Engine] ${user.chat_id} — no market found (category: ${preferred || "all"})`);
      return;
    }

    // Set cooldown BEFORE executing to prevent race conditions
    lastTradeTimes.set(user.chat_id, Date.now());

    const result = await executeTrade(fresh, match, signals);

    await sendAlert(fresh.chat_id,
      `✅ Trade Executed\n\n` +
      `${match.event.title}\n` +
      `${result.direction} | ₦${result.amount}\n` +
      `Fill: ${result.outcomeLabel}\n\n` +
      `Composite: ${(signals.composite * 100).toFixed(0)}%`
    );

  } catch (err) {
    console.error(`[Engine] ${user.chat_id} failed:`, err.message);
    await sendAlert(user.chat_id,
      `⚠️ Trade Failed\n\nConfidence: ${(signals.composite * 100).toFixed(0)}%\nError: ${err.message}`
    ).catch(() => {});
  }
}
