import { getGroups } from "../db/database.js";
import { postCrowdPoll } from "../signals/crowdSignal.js";

let bot = null;

// HARD KILL SWITCH (this is what you were missing)
let alertsEnabled = true;

export function setBot(botInstance) {
  bot = botInstance;
}

export function stopAlerts() {
  alertsEnabled = false;
}

export function startAlerts() {
  alertsEnabled = true;
}

// Prevent spam bursts
const lastSent = new Map();
const MIN_INTERVAL_MS = 60_000; // 1 min per group

function canSend(groupId) {
  const now = Date.now();
  const last = lastSent.get(groupId) || 0;
  if (now - last < MIN_INTERVAL_MS) return false;
  lastSent.set(groupId, now);
  return true;
}

// Safer escape (full markdown safety)
function esc(text) {
  if (!text) return "";
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/`/g, "\\`")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function signalBar(score = 0) {
  const clamped = Math.max(0, Math.min(1, score));
  const filled = Math.round(clamped * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled) + ` ${(clamped * 100).toFixed(0)}%`;
}

function directionEmoji(direction) {
  if (!direction) return "⚪";
  const d = String(direction).toLowerCase();
  if (["up", "bullish", "yes", "home"].includes(d)) return "🟢";
  if (["down", "bearish", "no", "away"].includes(d)) return "🔴";
  return "⚪";
}

export async function sendTradeAlert(chatId, result, signals, decision, errorMsg = null) {
  if (!bot || !alertsEnabled) return;

  let msg;

  if (errorMsg || !result) {
    msg =
      `⚠️ *Trade Failed*\n\n` +
      `Confidence: ${(decision?.composite * 100 || 0).toFixed(1)}%\n` +
      `Error: ${esc(errorMsg || "Unknown")}\n`;
  } else {
    const { tradeRecord, quote } = result;
    const price = quote?.price || quote?.expectedPrice || 0;
    const outcomeLabel = result?.outcomeLabel || tradeRecord?.outcome;

    msg =
      `🎯 *Trade Executed*\n\n` +
      `Event: ${esc(tradeRecord.event_title)}\n` +
      `Side: ${esc(tradeRecord.side)} ${esc(outcomeLabel)}\n` +
      `Amount: ${esc(tradeRecord.currency)} ${tradeRecord.amount}\n` +
      `Entry: ${(price * 100).toFixed(1)}¢\n` +
      `Signal: ${esc(tradeRecord.signal_source)}\n\n` +
      `Composite: ${(decision.composite * 100).toFixed(0)}%`;
  }

  await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
}

export async function broadcastToGroups(signals, forcePoll = false) {
  if (!bot || !alertsEnabled) return;

  const groups = await getGroups();
  if (!groups.length) return;

  const { crypto, sports, sentiment, composite } = signals;

  // Optional crowd poll mode
  if (forcePoll && composite >= 0.55) {
    try {
      await postCrowdPoll(signals, null);
    } catch (err) {
      console.error("[Alerts] Poll error:", err.message);
    }
    return;
  }

  // HARD THRESHOLD CONTROL
  if (composite < 0.60) return;

  const msg =
    `${composite >= 0.65 ? "🔥 HOT" : "⚡ WARM"} *Signal Update*\n\n` +
    `Crypto ${directionEmoji(crypto.direction)} ${signalBar(crypto.score)}\n` +
    `Sports ${directionEmoji(sports.direction)} ${signalBar(sports.score)}\n` +
    `Sentiment ${directionEmoji(sentiment.direction)} ${signalBar(sentiment.score)}\n\n` +
    `Composite ⚡ ${signalBar(composite)}`;

  for (const group of groups) {
    if (!canSend(group.group_id)) continue;

    try {
      await bot.sendMessage(group.group_id, msg, { parse_mode: "Markdown" });
    } catch (err) {
      console.error("[Alerts] Send failed:", err.message);
    }
  }
}
