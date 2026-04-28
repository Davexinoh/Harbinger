import { runAllSignals, findMatchingMarket } from "./scorer.js";
import { shouldTrade }                       from "./decisionGate.js";
import { executeTrade }                      from "./executor.js";
import { getActiveUsers, getRecentTrades }   from "../db/database.js";
import { sendTradeAlert, broadcastToGroups } from "../bot/alerts.js";
import { postCrowdPoll }                     from "../signals/crowdSignal.js";
import { decrypt }                           from "../utils/encryption.js";

const TICK_MS          = parseInt(process.env.ENGINE_TICK_INTERVAL_MS) || 60_000;
const WARMUP_THRESHOLD = parseFloat(process.env.SIGNAL_WARMUP_ALERT_THRESHOLD) || 0.55;
const MIN_TRADE_GAP_MS = 15 * 60 * 1000;

// Poll every 5 ticks to groups (5 min), signals only on meaningful change
const POLL_INTERVAL_TICKS   = 5;
let   tickCount              = 0;

const lastTradeTimes = new Map();

// Crowd poll — one per warmup cycle
let crowdPollPostedThisCycle = false;
let lastCompositeWasWarm     = false;

// Group broadcast — only on meaningful score change
let lastBroadcastScore           = 0;
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

// Get set of event IDs with unsettled (open/pending) trades for a user
function getUnsettledEventIds(chatId) {
  const trades = getRecentTrades(chatId, 50);
  return new Set(
    trades.filter(t => t.status === "open" || t.status === "pending").map(t => t.event_id)
  );
}

async function tick() {
  tickCount++;
  const users = getActiveUsers();
  if (!users.length) return;

  let signals;
  try {
    signals = await runAllSignals();
    console.log(
      `[Engine] tick#${tickCount} composite:${signals.composite.toFixed(2)} ` +
      `crypto:${signals.crypto.score.toFixed(2)} sports:${signals.sports.score.toFixed(2)} ` +
      `sentiment:${signals.sentiment.score.toFixed(2)}`
    );
  } catch (err) {
    console.error("[Engine] Signal run failed:", err.message);
    return;
  }

  const isWarm = signals.composite >= WARMUP_THRESHOLD;

  if (!isWarm && lastCompositeWasWarm) crowdPollPostedThisCycle = false;
  lastCompositeWasWarm = isWarm;

  // Post crowd poll to groups — once per warmup cycle, 30 min open period
  if (isWarm && !crowdPollPostedThisCycle && users.length > 0) {
    try {
      const pubKey = decrypt(users[0].bayse_pub_key);
      const unsettled = getUnsettledEventIds(users[0].chat_id);
      const match  = await findMatchingMarket(signals, pubKey, unsettled);
      await postCrowdPoll(signals, match);
      crowdPollPostedThisCycle = true;
    } catch (err) {
      console.error("[Engine] Crowd poll error:", err.message);
    }
  }

  // Send polls to groups every POLL_INTERVAL_TICKS regardless of score change
  // This keeps groups active with polls more than signal broadcasts
  if (tickCount % POLL_INTERVAL_TICKS === 0 && isWarm) {
    try {
      await broadcastToGroups(signals, true); // force poll broadcast
    } catch (err) {
      console.error("[Engine] Poll broadcast error:", err.message);
    }
  } else {
    // Signal broadcast only on meaningful score change
    const scoreDelta = Math.abs(signals.composite - lastBroadcastScore);
    if (scoreDelta >= BROADCAST_CHANGE_THRESHOLD) {
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

  const lastTrade     = lastTradeTimes.get(chatId) || 0;
  const timeSinceLast = Date.now() - lastTrade;
  if (timeSinceLast < MIN_TRADE_GAP_MS) {
    const waitMins = Math.ceil((MIN_TRADE_GAP_MS - timeSinceLast) / 60000);
    console.log(`[Engine] ${chatId} — cooldown: ${waitMins}min remaining`);
    return;
  }

  const pubKey          = decrypt(user.bayse_pub_key);
  const unsettledIds    = getUnsettledEventIds(chatId);
  const preferredCat    = user.preferred_category || null;
  const match           = await findMatchingMarket(signals, pubKey, unsettledIds, preferredCat);

  if (!match) {
    console.log(`[Engine] ${chatId} — no matching market (unsettled: ${unsettledIds.size})`);
    return;
  }

  try {
    const result = await executeTrade(user, match, decision);
    lastTradeTimes.set(chatId, Date.now());
    console.log(`[Engine] ${chatId} — trade fired: ${match.event.title} [${match.category}]`);
    await sendTradeAlert(chatId, result, signals, decision);
  } catch (err) {
    console.error(`[Engine] ${chatId} — trade failed: ${err.message}`);
    lastTradeTimes.set(chatId, Date.now()); // cooldown on failure too
    await sendTradeAlert(chatId, null, signals, decision, err.message);
  }
}

export function getEngineStatus() {
  return { running: isRunning, tickIntervalMs: TICK_MS, activeUsers: getActiveUsers().length };
}
