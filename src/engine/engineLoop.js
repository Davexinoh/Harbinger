import { runAllSignals, findMatchingMarket } from "./scorer.js";
import { shouldTrade }                       from "./decisionGate.js";
import { executeTrade }                      from "./executor.js";
import { checkRisk, recordLoss, recordWin }  from "./riskManager.js";
import { getActiveUsers, getUnsettledEventIds, updateUser } from "../db/database.js";
import { sendTradeAlert, broadcastToGroups } from "../bot/alerts.js";
import { postCrowdPoll }                     from "../signals/crowdSignal.js";
import { decrypt }                           from "../utils/encryption.js";

const TICK_MS          = parseInt(process.env.ENGINE_TICK_INTERVAL_MS) || 60_000;
const WARMUP_THRESHOLD = parseFloat(process.env.SIGNAL_WARMUP_ALERT_THRESHOLD) || 0.55;
const MIN_TRADE_GAP_MS = 15 * 60 * 1000;

const POLL_INTERVAL_TICKS        = 5;
let   tickCount                  = 0;
const lastTradeTimes             = new Map();
let   crowdPollPostedThisCycle   = false;
let   lastCompositeWasWarm       = false;
let   lastBroadcastScore         = 0;
const BROADCAST_CHANGE_THRESHOLD = 0.08;

let tickTimer = null;
let isRunning = false;

export function startEngine() {
  if (isRunning) return;
  isRunning = true;
  console.log("[Engine] Starting Harbinger...");
  tick();
  tickTimer = setInterval(tick, TICK_MS);
}

export function stopEngine() {
  if (tickTimer) clearInterval(tickTimer);
  isRunning = false;
}

async function tick() {
  tickCount++;
  const users = await getActiveUsers();
  if (!users.length) return;

  let signals;
  try {
    // Pass preferred category of first active user for signal weighting
    const primaryUser = users[0];
    signals = await runAllSignals(primaryUser.preferred_category);
    console.log(
      `[Engine] tick#${tickCount} composite:${signals.composite.toFixed(2)} ` +
      `btc15m:${signals.btc15m?.score.toFixed(2)} crypto:${signals.crypto.score.toFixed(2)} ` +
      `fx:${signals.fx?.score.toFixed(2)} sports:${signals.sports.score.toFixed(2)}`
    );
  } catch (err) {
    console.error("[Engine] Signal run failed:", err.message);
    return;
  }

  const isWarm = signals.composite >= WARMUP_THRESHOLD;

  if (!isWarm && lastCompositeWasWarm) crowdPollPostedThisCycle = false;
  lastCompositeWasWarm = isWarm;

  // Crowd poll — once per warmup cycle (display only, not used in trading)
  if (isWarm && !crowdPollPostedThisCycle && users.length > 0) {
    try {
      const pubKey    = decrypt(users[0].bayse_pub_key);
      const unsettled = await getUnsettledEventIds(users[0].chat_id);
      const match     = await findMatchingMarket(signals, pubKey, unsettled);
      await postCrowdPoll(signals, match);
      crowdPollPostedThisCycle = true;
    } catch (err) {
      console.error("[Engine] Crowd poll error:", err.message);
    }
  }

  // Group broadcasts
  if (tickCount % POLL_INTERVAL_TICKS === 0 && isWarm) {
    try { await broadcastToGroups(signals, true); } catch (err) {
      console.error("[Engine] Poll broadcast error:", err.message);
    }
  } else {
    const delta = Math.abs(signals.composite - lastBroadcastScore);
    if (delta >= BROADCAST_CHANGE_THRESHOLD) {
      try {
        await broadcastToGroups(signals, false);
        lastBroadcastScore = signals.composite;
      } catch (err) {
        console.error("[Engine] Broadcast error:", err.message);
      }
    }
  }

  for (const user of users) {
    try {
      await processUser(user, signals);
    } catch (err) {
      console.error(`[Engine] User ${user.chat_id} error:`, err.message);
    }
  }
}

async function processUser(user, signals) {
  const chatId = user.chat_id;

  const decision = shouldTrade(signals, user);
  if (!decision.fire) {
    console.log(`[Engine] ${chatId} — ${decision.reason}`);
    return;
  }

  // Cooldown between trades
  const lastTrade = lastTradeTimes.get(chatId) || 0;
  const sinceMs   = Date.now() - lastTrade;
  if (sinceMs < MIN_TRADE_GAP_MS) {
    console.log(`[Engine] ${chatId} — cooldown: ${Math.ceil((MIN_TRADE_GAP_MS - sinceMs) / 60000)}min`);
    return;
  }

  const pubKey      = decrypt(user.bayse_pub_key);
  const unsettled   = await getUnsettledEventIds(chatId);
  const match       = await findMatchingMarket(signals, pubKey, unsettled, user.preferred_category);

  if (!match) {
    console.log(`[Engine] ${chatId} — no matching market`);
    return;
  }

  // Risk check — adjusts amount, checks balance, daily limits, market quality
  const risk = await checkRisk(user, match, decision, signals);

  if (!risk.allowed) {
    console.log(`[Engine] ${chatId} — risk blocked: ${risk.reason}`);

    // Auto-pause if daily loss limit hit
    if (risk.pauseEngine) {
      await updateUser(chatId, { engine_active: 0 });
      try {
        const { default: bot } = await import("../bot/alerts.js");
        // notify user via bot — imported lazily to avoid circular
      } catch (_) {}
      console.log(`[Engine] ${chatId} — engine AUTO-PAUSED (daily loss limit)`);
    }
    return;
  }

  // Update decision amount with risk-adjusted amount
  decision.amount = risk.amount;

  try {
    const result = await executeTrade(user, match, decision);
    lastTradeTimes.set(chatId, Date.now());
    console.log(`[Engine] ${chatId} ✓ ${match.event.title} [${match.category}]`);
    await sendTradeAlert(chatId, result, signals, decision);
  } catch (err) {
    console.error(`[Engine] ${chatId} — trade failed: ${err.message}`);
    lastTradeTimes.set(chatId, Date.now());
    await sendTradeAlert(chatId, null, signals, decision, err.message);
  }
}

export function getEngineStatus() {
  return { running: isRunning, tickIntervalMs: TICK_MS, activeUsers: 0 };
}
