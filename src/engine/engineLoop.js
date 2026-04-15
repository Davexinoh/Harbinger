import { runAllSignals, findMatchingMarket } from "./scorer.js";
import { shouldTrade }                       from "./decisionGate.js";
import { executeTrade }                      from "./executor.js";
import { getActiveUsers }                    from "../db/database.js";
import { sendTradeAlert, sendSignalWarning, broadcastToGroups } from "../bot/alerts.js";
import { postCrowdPoll }                     from "../signals/crowdSignal.js";
import { decrypt }                           from "../utils/encryption.js";

const TICK_MS          = parseInt(process.env.ENGINE_TICK_INTERVAL_MS) || 60_000;
const WARMUP_THRESHOLD = parseFloat(process.env.SIGNAL_WARMUP_ALERT_THRESHOLD) || 0.60;
const MIN_TRADE_GAP_MS = 10 * 60 * 1000;

const lastTradeTimes         = new Map();
// key: `chatId:signalSource` — cooldown prevents same alert firing more than once per hour
const lastWarmupAlerts       = new Map();
const WARMUP_ALERT_COOLDOWN  = 60 * 60 * 1000;
let crowdPollPostedThisCycle = false;
let lastCompositeWasWarm     = false;
let tickTimer                = null;
let isRunning                = false;

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

  console.log(`[Engine] Tick — ${users.length} active user(s)`);

  let signals;
  try {
    signals = await runAllSignals();
    console.log(
      `[Engine] crypto:${signals.crypto.score.toFixed(2)} sports:${signals.sports.score.toFixed(2)} ` +
      `sentiment:${signals.sentiment.score.toFixed(2)} crowd:${signals.crowd.score.toFixed(2)} ` +
      `composite:${signals.composite.toFixed(2)}`
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

  // Post crowd poll once per warmup cycle — use first active user's key
  if (isWarm && !crowdPollPostedThisCycle && users.length > 0) {
    try {
      const firstUser = users[0];
      const pubKey    = decrypt(firstUser.bayse_pub_key);
      const match     = await findMatchingMarket(signals, pubKey);
      await postCrowdPoll(signals, match);
      crowdPollPostedThisCycle = true;
    } catch (err) {
      console.error("[Engine] Crowd poll error:", err.message);
    }
  }

  try { await broadcastToGroups(signals); } catch (err) {
    console.error("[Engine] Broadcast error:", err.message);
  }

  const warmupSignals = ["crypto", "sports", "sentiment"].filter(
    (src) => signals[src].score >= WARMUP_THRESHOLD
  );

  for (const user of users) {
    try {
      await processUser(user, signals, warmupSignals);
    } catch (err) {
      console.error(`[Engine] User ${user.chat_id} error:`, err.message);
    }
  }

}

async function processUser(user, signals, warmupSignals) {
  const chatId = user.chat_id;

  const now = Date.now();
  for (const src of warmupSignals) {
    const key = chatId + ":" + src;
    const last = lastWarmupAlerts.get(key) || 0;
    if (now - last >= WARMUP_ALERT_COOLDOWN) {
      await sendSignalWarning(chatId, signals[src]);
      lastWarmupAlerts.set(key, now);
    }
  }

  const decision = shouldTrade(signals, user);
  if (!decision.fire) {
    console.log(`[Engine] ${chatId} — no trade: ${decision.reason}`);
    return;
  }

  const lastTrade = lastTradeTimes.get(chatId) || 0;
  if (Date.now() - lastTrade < MIN_TRADE_GAP_MS) {
    console.log(`[Engine] ${chatId} — cooldown active`);
    return;
  }

  // Use this user's own keys to find market
  const pubKey = decrypt(user.bayse_pub_key);
  const match  = await findMatchingMarket(signals, pubKey);

  if (!match) {
    console.log(`[Engine] ${chatId} — no matching market`);
    return;
  }

  try {
    const result = await executeTrade(user, match, decision);
    lastTradeTimes.set(chatId, Date.now());
    console.log(`[Engine] ${chatId} — trade fired: ${match.event.title}`);
    await sendTradeAlert(chatId, result, signals, decision);
  } catch (err) {
    console.error(`[Engine] ${chatId} — trade failed:`, err.message);
    await sendTradeAlert(chatId, null, signals, decision, err.message);
  }
}

export function getEngineStatus() {
  return { running: isRunning, tickIntervalMs: TICK_MS, activeUsers: getActiveUsers().length };
                                          }
      
