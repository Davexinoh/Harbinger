import { runAllSignals, findMatchingMarket } from "./scorer.js";
import { shouldTrade } from "./decisionGate.js";
import { executeTrade } from "./executor.js";
import { getActiveUsers } from "../db/database.js";
import { sendTradeAlert, sendSignalWarning, broadcastToGroups } from "../bot/alerts.js";
import { postCrowdPoll } from "../signals/crowdSignal.js";

const TICK_MS          = parseInt(process.env.ENGINE_TICK_INTERVAL_MS) || 60_000;
const WARMUP_THRESHOLD = parseFloat(process.env.SIGNAL_WARMUP_ALERT_THRESHOLD) || 0.60;

// Minimum gap between trades per user — avoid overtrading
const MIN_TRADE_GAP_MS = 10 * 60 * 1000;
const lastTradeTimes   = new Map();

// Track warmup alerts sent this cycle
const warmupAlertsSent = new Set();

// Track whether a crowd poll was already posted this warmup cycle
// Reset when composite drops back below WARMUP_THRESHOLD
let crowdPollPostedThisCycle = false;
let lastCompositeWasWarm     = false;

let tickTimer = null;
let isRunning = false;

export function startEngine() {
  if (isRunning) return;
  isRunning = true;
  console.log("[Engine] Starting Harbinger signal engine...");
  tick();
  tickTimer = setInterval(tick, TICK_MS);
}

export function stopEngine() {
  if (tickTimer) clearInterval(tickTimer);
  isRunning = false;
  console.log("[Engine] Engine stopped.");
}

async function tick() {
  const users = getActiveUsers();
  if (!users.length) return;

  console.log(`[Engine] Tick — ${users.length} active user(s)`);

  let signals;
  try {
    signals = await runAllSignals();
    console.log(
      `[Engine] Signals — crypto: ${signals.crypto.score.toFixed(3)} | ` +
      `sports: ${signals.sports.score.toFixed(3)} | ` +
      `sentiment: ${signals.sentiment.score.toFixed(3)} | ` +
      `crowd: ${signals.crowd.score.toFixed(3)} (${signals.crowd.totalVotes || 0} votes) | ` +
      `composite: ${signals.composite.toFixed(3)}`
    );
  } catch (err) {
    console.error("[Engine] Signal run failed:", err.message);
    return;
  }

  const isWarm = signals.composite >= WARMUP_THRESHOLD;

  // Reset crowd poll cycle tracker when composite cools down
  if (!isWarm && lastCompositeWasWarm) {
    crowdPollPostedThisCycle = false;
    console.log("[Engine] Composite cooled — crowd poll cycle reset");
  }
  lastCompositeWasWarm = isWarm;

  // Post crowd poll once per warmup cycle — the moment composite first crosses warmup threshold
  if (isWarm && !crowdPollPostedThisCycle) {
    try {
      const match = await findMatchingMarket(signals);
      await postCrowdPoll(signals, match);
      crowdPollPostedThisCycle = true;
      console.log("[Engine] Crowd poll posted for this warmup cycle");
    } catch (err) {
      console.error("[Engine] Crowd poll post error:", err.message);
    }
  }

  // Broadcast signal state to groups
  try {
    await broadcastToGroups(signals);
  } catch (err) {
    console.error("[Engine] Group broadcast error:", err.message);
  }

  // Warmup alerts per user
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

  warmupAlertsSent.clear();
}

async function processUser(user, signals, warmupSignals) {
  const chatId = user.chat_id;

  // Warmup alerts
  if (warmupSignals.length && !warmupAlertsSent.has(chatId)) {
    for (const src of warmupSignals) {
      await sendSignalWarning(chatId, signals[src]);
    }
    warmupAlertsSent.add(chatId);
  }

  const decision = shouldTrade(signals, user);
  if (!decision.fire) {
    console.log(`[Engine] User ${chatId} — no trade: ${decision.reason}`);
    return;
  }

  // Cooldown check
  const lastTrade = lastTradeTimes.get(chatId) || 0;
  if (Date.now() - lastTrade < MIN_TRADE_GAP_MS) {
    console.log(`[Engine] User ${chatId} — cooldown active`);
    return;
  }

  const match = await findMatchingMarket(signals);
  if (!match) {
    console.log(`[Engine] User ${chatId} — no matching market`);
    return;
  }

  try {
    const result = await executeTrade(user, match, decision);
    lastTradeTimes.set(chatId, Date.now());
    console.log(
      `[Engine] User ${chatId} — trade fired: ${match.event.title} | ` +
      `${result.tradeRecord.outcome} @ ${result.quote.expectedPrice}`
    );
    await sendTradeAlert(chatId, result, signals, decision);
  } catch (err) {
    console.error(`[Engine] User ${chatId} — trade failed:`, err.message);
    await sendTradeAlert(chatId, null, signals, decision, err.message);
  }
}

export function getEngineStatus() {
  return {
    running: isRunning,
    tickIntervalMs: TICK_MS,
    activeUsers: getActiveUsers().length,
  };
}
