import { runAllSignals, findMatchingMarket } from "./scorer.js";
import { shouldTrade }    from "./decisionGate.js";
import { executeTrade }   from "./executor.js";
import { getActiveUsers, getUnsettledEventIds, getUser } from "../db/database.js";
import { sendTradeAlert, broadcastSignals } from "../bot/alerts.js";
import { decrypt } from "../utils/encryption.js";

const TICK_MS          = 60_000;
const MIN_TRADE_GAP_MS = 15 * 60 * 1000;

let ticking         = false;
let isRunning       = false;
let tickTimer       = null;
let activeUserCount = 0;

const userLocks      = new Map();
const lastTradeTimes = new Map();
const executedKeys   = new Set();
const EXEC_WINDOW    = 60_000;

function makeTradeKey(userId, eventId) {
  const bucket = Math.floor(Date.now() / EXEC_WINDOW);
  return `${userId}:${eventId}:${bucket}`;
}

function isDuplicateTrade(key) {
  if (executedKeys.has(key)) return true;
  executedKeys.add(key);
  setTimeout(() => executedKeys.delete(key), EXEC_WINDOW);
  return false;
}

export function startEngine() {
  if (isRunning) return;
  isRunning = true;
  console.log("[Engine] Started");
  tick();
  tickTimer = setInterval(tick, TICK_MS);
}

export function stopEngine() {
  if (tickTimer) clearInterval(tickTimer);
  isRunning = false;
}

async function tick() {
  if (ticking) return;
  ticking = true;

  try {
    const users = await getActiveUsers();
    activeUserCount = users.length;
    if (!users.length) return;

    const signals = await runAllSignals();
    console.log(`[Engine] composite=${signals.composite.toFixed(2)}`);

    if (signals.composite >= 0.60) {
      await broadcastSignals(signals).catch(() => {});
    }

    // FIX: decrypt properly, not Buffer.from base64
    const pubKey    = decrypt(users[0].bayse_pub_key);
    const unsettled = await getUnsettledEventIds(users[0].chat_id);

    for (const user of users) {
      processUserSafe(user, signals, pubKey, unsettled);
    }

  } catch (err) {
    console.error("[Engine] Tick error:", err.message);
  } finally {
    ticking = false;
  }
}

async function processUserSafe(user, signals, pubKey, unsettled) {
  const id = user.chat_id;
  if (userLocks.get(id)) return;
  userLocks.set(id, true);
  try {
    await processUser(user, signals, pubKey, unsettled);
  } finally {
    userLocks.delete(id);
  }
}

async function processUser(user, signals, pubKey, unsettled) {
  const chatId = user.chat_id;

  const fresh = await getUser(chatId);
  if (!fresh?.engine_active) return;

  const decision = shouldTrade(signals, fresh);
  if (!decision.fire) return;

  const last = lastTradeTimes.get(chatId) || 0;
  if (Date.now() - last < MIN_TRADE_GAP_MS) return;

  // Pass preferred category — but fall back to ALL markets if none found
  const preferred = fresh.preferred_category && fresh.preferred_category !== "all"
    ? fresh.preferred_category
    : null;

  const match = await findMatchingMarket(signals, pubKey, unsettled, preferred);
  if (!match) {
    console.log(`[Engine] ${chatId} — no matching market found (category: ${preferred || "all"})`);
    return;
  }

  const key = makeTradeKey(chatId, match.event.id);
  if (isDuplicateTrade(key)) return;

  const currency  = fresh.currency || "USD";
  const max       = parseFloat(fresh.max_trade_amount) || (currency === "NGN" ? 500 : 5);
  const threshold = parseFloat(fresh.threshold) || 0.6;
  const scale     = Math.min((signals.composite - threshold) / (0.95 - threshold), 1);

  let amount = max * (0.5 + 0.5 * scale);
  if (currency === "NGN") amount = Math.max(Math.round(amount), 100);
  else                    amount = Math.max(parseFloat(amount.toFixed(2)), 1);

  decision.amount = amount;

  const latest = await getUser(chatId);
  if (!latest?.engine_active) return;

  try {
    const result = await executeTrade(latest, match, decision);
    lastTradeTimes.set(chatId, Date.now());
    await sendTradeAlert(chatId, result, decision);
    console.log(`[Engine] ${chatId} ✓ ${match.event.title}`);
  } catch (err) {
    lastTradeTimes.set(chatId, Date.now());
    await sendTradeAlert(chatId, null, decision, err.message);
    console.error(`[Engine] ${chatId} failed:`, err.message);
  }
}

export function getEngineStatus() {
  return { running: isRunning, activeUsers: activeUserCount };
}
