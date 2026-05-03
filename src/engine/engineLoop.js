import { runAllSignals, findMatchingMarket } from "./scorer.js";
import { shouldTrade }                       from "./decisionGate.js";
import { executeTrade }                      from "./executor.js";
import { getActiveUsers, getUnsettledEventIds, getUser } from "../db/database.js";
import { sendTradeAlert, broadcastToGroups } from "../bot/alerts.js";
import { postCrowdPoll }                     from "../signals/crowdSignal.js";
import { decrypt }                           from "../utils/encryption.js";

const TICK_MS          = parseInt(process.env.ENGINE_TICK_INTERVAL_MS) || 60_000;
const WARMUP_THRESHOLD = parseFloat(process.env.SIGNAL_WARMUP_ALERT_THRESHOLD) || 0.55;
const MIN_TRADE_GAP_MS = 15 * 60 * 1000;
const POLL_TICKS       = 5;

let tickCount              = 0;
const lastTradeTimes       = new Map();
let crowdPollPosted        = false;
let lastWasWarm            = false;
let lastBroadcastScore     = 0;
const BROADCAST_DELTA      = 0.08;
let tickTimer              = null;
let isRunning              = false;

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
    signals = await runAllSignals();
    console.log(`[Engine] tick#${tickCount} composite:${signals.composite.toFixed(2)} crypto:${signals.crypto.score.toFixed(2)} sports:${signals.sports.score.toFixed(2)} btc15m:${signals.btc15m?.score.toFixed(2)}`);
  } catch (err) {
    console.error("[Engine] Signal run failed:", err.message);
    return;
  }

  const isWarm = signals.composite >= WARMUP_THRESHOLD;
  if (!isWarm && lastWasWarm) crowdPollPosted = false;
  lastWasWarm = isWarm;

  if (isWarm && !crowdPollPosted && users.length > 0) {
    try {
      const pubKey    = decrypt(users[0].bayse_pub_key);
      const unsettled = await getUnsettledEventIds(users[0].chat_id);
      const match     = await findMatchingMarket(signals, pubKey, unsettled);
      await postCrowdPoll(signals, match);
      crowdPollPosted = true;
    } catch (err) { console.error("[Engine] Poll error:", err.message); }
  }

  if (tickCount % POLL_TICKS === 0 && isWarm) {
    try { await broadcastToGroups(signals, true); } catch (_) {}
  } else if (Math.abs(signals.composite - lastBroadcastScore) >= BROADCAST_DELTA) {
    try { await broadcastToGroups(signals, false); lastBroadcastScore = signals.composite; } catch (_) {}
  }

  for (const user of users) {
    try { await processUser(user, signals); }
    catch (err) { console.error(`[Engine] User ${user.chat_id}:`, err.message); }
  }
}

async function processUser(user, signals) {
  const chatId = user.chat_id;

  // Re-fetch user from DB to catch /stop that happened mid-tick
  const fresh = await getUser(chatId);
  if (!fresh?.engine_active) {
    console.log(`[Engine] ${chatId} — engine stopped, skipping`);
    return;
  }

  const decision = shouldTrade(signals, fresh);
  if (!decision.fire) { console.log(`[Engine] ${chatId} — ${decision.reason}`); return; }

  const lastTrade = lastTradeTimes.get(chatId) || 0;
  const sinceMs   = Date.now() - lastTrade;
  if (sinceMs < MIN_TRADE_GAP_MS) {
    console.log(`[Engine] ${chatId} — cooldown: ${Math.ceil((MIN_TRADE_GAP_MS - sinceMs)/60000)}min`);
    return;
  }

  const pubKey    = decrypt(fresh.bayse_pub_key);
  const unsettled = await getUnsettledEventIds(chatId);
  const match     = await findMatchingMarket(signals, pubKey, unsettled, fresh.preferred_category);
  if (!match) { console.log(`[Engine] ${chatId} — no market`); return; }

  // Amount — respect user currency minimum
  const currency  = fresh.currency || "USD";
  const maxAmount = parseFloat(fresh.max_trade_usd) || (currency === "NGN" ? 500 : 5);
  const threshold = parseFloat(fresh.threshold) || 0.60;
  const scale     = Math.min((signals.composite - threshold) / (0.95 - threshold), 1);
  const rawAmount = maxAmount * 0.5 + maxAmount * 0.5 * scale;

  decision.amount = currency === "NGN"
    ? Math.max(Math.round(rawAmount), 100)
    : Math.max(parseFloat(rawAmount.toFixed(2)), 1);

  try {
    const result = await executeTrade(fresh, match, decision);
    lastTradeTimes.set(chatId, Date.now());
    console.log(`[Engine] ${chatId} ✓ "${match.event.title}"`);
    await sendTradeAlert(chatId, result, signals, decision);
  } catch (err) {
    console.error(`[Engine] ${chatId} failed: ${err.message}`);
    lastTradeTimes.set(chatId, Date.now());
    await sendTradeAlert(chatId, null, signals, decision, err.message);
  }
}

export function getEngineStatus() {
  return { running: isRunning, tickIntervalMs: TICK_MS, activeUsers: 0 };
}
