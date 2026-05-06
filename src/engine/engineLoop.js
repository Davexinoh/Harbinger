import { runAllSignals } from "../signals/index.js";
import { findMarket }    from "./scorer.js";
import { executeTrade }  from "./executor.js";
import { getActiveUsers, getOpenEventIds, getUser } from "../db/database.js";
import { decrypt } from "../utils/encryption.js";
import { sendAlert } from "../bot/alerts.js";

const TICK_MS = 60_000;
let timer = null, running = false, activeCount = 0;

// Per-user processing lock — prevents concurrent ticks for same user
const locks = new Map();

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

    // Use first user's pub key for market fetching (public endpoint)
    const pubKey   = decrypt(users[0].bayse_pub_key);
    const signals  = await runAllSignals(pubKey);

    console.log(`[Engine] composite=${signals.composite.toFixed(3)} | ${users.length} active users`);

    for (const user of users) {
      if (!locks.get(user.chat_id)) {
        locks.set(user.chat_id, true);
        processUser(user, signals, pubKey)
          .finally(() => locks.delete(user.chat_id));
      }
    }
  } catch (err) {
    console.error("[Engine] Tick error:", err.message);
  }
}

async function processUser(user, signals, pubKey) {
  try {
    // Re-fetch from DB — ensure engine_active is still true
    const fresh = await getUser(user.chat_id);
    if (!fresh?.engine_active) return;

    const threshold = parseFloat(fresh.threshold) || 0.6;
    if (signals.composite < threshold) return;

    // Check what events this user already has open trades on
    const excluded = await getOpenEventIds(fresh.chat_id);

    const preferred = fresh.preferred_category || "all";
    const match     = await findMarket(pubKey, preferred, excluded);
    if (!match) return;

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
