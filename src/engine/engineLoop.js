import { runAllSignals, findMatchingMarket } from "./scorer.js";
import { shouldTrade }                       from "./decisionGate.js";
import { executeTrade }                      from "./executor.js";
import { getActiveUsers }                    from "../db/database.js";
import { sendTradeAlert, broadcastToGroups } from "../bot/alerts.js";
import { postCrowdPoll }                     from "../signals/crowdSignal.js";
import { decrypt }                           from "../utils/encryption.js";

const TICK_MS          = parseInt(process.env.ENGINE_TICK_INTERVAL_MS) || 60_000;
const WARMUP_THRESHOLD = parseFloat(process.env.SIGNAL_WARMUP_ALERT_THRESHOLD) || 0.60;
const MIN_TRADE_GAP_MS = 15 * 60 * 1000; // 15 min between trades per user

// Per-user trade cooldown — key: chatId → timestamp of last trade
const lastTradeTimes = new Map();

// Track last event traded per user — prevent same event back to back
const lastTradeEventId = new Map();

// Group broadcast — only when score shifts meaningfully
let lastBroadcastScore = 0;
const BROADCAST_CHANGE_THRESHOLD = 0.08;

// Crowd poll — one per warmup cycle
let crowdPollPostedThisCycle = false;
let lastCompositeWasWarm     = false;

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

  if (!isWarm && lastCompositeWasWarm) {
    crowdPollPostedThisCycle = false;
  }
  lastCompositeWasWarm = isWarm;

  // Crowd poll — once per warmup cycle
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

  // Group broadcast — only on meaningful score change
  const scoreDelta = Math.abs(signals.composite - lastBroadcastScore);
  if (scoreDelta >= BROADCAST_CHANGE_THRESHOLD) {
    try {
      await broadcastToGroups(signals);
      lastBroadcastScore = signals.composite;
    } catch (err) {
      console.error("[Engine] Broadcast error:", err.message);
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

  // Hard cooldown check — must be after shouldTrade to log the reason
  const lastTrade = lastTradeTimes.get(chatId) || 0;
  const timeSinceLast = Date.now() - lastTrade;
  if (timeSinceLast < MIN_TRADE_GAP_MS) {
    const waitMins = Math.ceil((MIN_TRADE_GAP_MS - timeSinceLast) / 60000);
    console.log(`[Engine] ${chatId} — cooldown: ${waitMins}min remaining`);
    return;
  }

  const pubKey = decrypt(user.bayse_pub_key);

  // Pass last traded event ID so scorer can avoid repeating it
  const lastEventId = lastTradeEventId.get(chatId);
  const match = await findMatchingMarket(signals, pubKey, lastEventId);

  if (!match) {
    console.log(`[Engine] ${chatId} — no matching market`);
    return;
  }

  try {
    const result = await executeTrade(user, match, decision);

    // Set cooldown IMMEDIATELY after successful trade
    lastTradeTimes.set(chatId, Date.now());
    lastTradeEventId.set(chatId, match.event.id);

    console.log(`[Engine] ${chatId} — trade fired: ${match.event.title}`);
    await sendTradeAlert(chatId, result, signals, decision);
  } catch (err) {
    console.error(`[Engine] ${chatId} — trade failed: ${err.message}`);

    // Also set cooldown on failure — don't retry same market immediately
    lastTradeTimes.set(chatId, Date.now());

    await sendTradeAlert(chatId, null, signals, decision, err.message);
  }
}

export function getEngineStatus() {
  return {
    running:       isRunning,
    tickIntervalMs: TICK_MS,
    activeUsers:   getActiveUsers().length,
  };
}
