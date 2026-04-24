import { runAllSignals, findMatchingMarket } from "./scorer.js";
import { shouldTrade }                       from "./decisionGate.js";
import { executeTrade }                      from "./executor.js";
import { getActiveUsers }                    from "../db/database.js";
import { sendTradeAlert, broadcastToGroups } from "../bot/alerts.js";
import { postCrowdPoll }                     from "../signals/crowdSignal.js";
import { decrypt }                           from "../utils/encryption.js";

const TICK_MS          = parseInt(process.env.ENGINE_TICK_INTERVAL_MS) || 60_000;
const WARMUP_THRESHOLD = parseFloat(process.env.SIGNAL_WARMUP_ALERT_THRESHOLD) || 0.60;
const MIN_TRADE_GAP_MS = 10 * 60 * 1000;

// Per-user trade cooldown
const lastTradeTimes = new Map();

// Track which signals are currently in warmup state per user
// key: `chatId:src` → true/false (was warm last tick)
// Alert fires only on the rising edge — when it crosses into warm, not while it stays warm
const signalWasWarm = new Map();

// Crowd poll — one per warmup cycle
let crowdPollPostedThisCycle = false;
let lastCompositeWasWarm     = false;

// Group broadcast — only when composite changes meaningfully (not every tick)
let lastBroadcastScore = 0;
const BROADCAST_CHANGE_THRESHOLD = 0.08; // only broadcast if score shifted by 8%+

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
  const users = getActiveUsers();
  if (!users.length) return;

  let signals;
  try {
    signals = await runAllSignals();
    console.log(
      `[Engine] composite:${signals.composite.toFixed(2)} ` +
      `crypto:${signals.crypto.score.toFixed(2)} ` +
      `sports:${signals.sports.score.toFixed(2)} ` +
      `sentiment:${signals.sentiment.score.toFixed(2)}`
    );
  } catch (err) {
    console.error("[Engine] Signal run failed:", err.message);
    return;
  }

  const isWarm = signals.composite >= WARMUP_THRESHOLD;

  // Reset crowd poll cycle when composite cools
  if (!isWarm && lastCompositeWasWarm) {
    crowdPollPostedThisCycle = false;
  }
  lastCompositeWasWarm = isWarm;

  // Crowd poll — once per warmup cycle only
  if (isWarm && !crowdPollPostedThisCycle && users.length > 0) {
    try {
      const pubKey = decrypt(users[0].bayse_pub_key);
      const match  = await findMatchingMarket(signals, pubKey);
      await postCrowdPoll(signals, match);
      crowdPollPostedThisCycle = true;
    } catch (err) {
      console.error("[Engine] Crowd poll error:", err.message);
    }
  }

  // Group broadcast — only when score shifts meaningfully
  const scoreDelta = Math.abs(signals.composite - lastBroadcastScore);
  if (scoreDelta >= BROADCAST_CHANGE_THRESHOLD) {
    try {
      await broadcastToGroups(signals);
      lastBroadcastScore = signals.composite;
    } catch (err) {
      console.error("[Engine] Broadcast error:", err.message);
    }
  }

  // Per-user processing
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

  // Check trade decision first — no spam if we're just going to trade anyway
  const decision = shouldTrade(signals, user);

  if (!decision.fire) {
    console.log(`[Engine] ${chatId} — ${decision.reason}`);
    return;
  }

  // Cooldown between trades
  const lastTrade = lastTradeTimes.get(chatId) || 0;
  if (Date.now() - lastTrade < MIN_TRADE_GAP_MS) {
    console.log(`[Engine] ${chatId} — cooldown active`);
    return;
  }

  // Find matching market using user's own key
  const pubKey = decrypt(user.bayse_pub_key);
  const match  = await findMatchingMarket(signals, pubKey);

  if (!match) {
    console.log(`[Engine] ${chatId} — no matching market found`);
    return;
  }

  // Execute trade
  try {
    const result = await executeTrade(user, match, decision);
    lastTradeTimes.set(chatId, Date.now());
    console.log(`[Engine] ${chatId} — trade fired: ${match.event.title}`);
    await sendTradeAlert(chatId, result, signals, decision);
  } catch (err) {
    console.error(`[Engine] ${chatId} — trade failed: ${err.message}`);
    await sendTradeAlert(chatId, null, signals, decision, err.message);
  }
}

export function getEngineStatus() {
  return { running: isRunning, tickIntervalMs: TICK_MS, activeUsers: getActiveUsers().length };
}
