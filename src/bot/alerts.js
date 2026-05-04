import { getGroups } from "../db/database.js";

let bot = null;

export function setBot(botInstance) {
  bot = botInstance;
}

// --- Deduplication (in-memory, time-bucketed) ---
const sentKeys = new Set();
const DEDUP_WINDOW_MS = 60_000;

function makeKey(groupId, msg) {
  const bucket = Math.floor(Date.now() / DEDUP_WINDOW_MS);
  return `${groupId}:${bucket}:${msg}`;
}

function isDuplicate(key) {
  if (sentKeys.has(key)) return true;
  sentKeys.add(key);
  setTimeout(() => sentKeys.delete(key), DEDUP_WINDOW_MS);
  return false;
}

// --- Escape ---
function esc(text) {
  if (!text) return "";
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

// --- UI helpers ---
function bar(score = 0) {
  const s = Math.max(0, Math.min(1, score));
  const f = Math.round(s * 10);
  return "█".repeat(f) + "░".repeat(10 - f) + ` ${(s * 100).toFixed(0)}%`;
}

function emoji(dir) {
  if (!dir) return "⚪";
  const d = dir.toLowerCase();
  if (["up","bullish","yes","home"].includes(d)) return "🟢";
  if (["down","bearish","no","away"].includes(d)) return "🔴";
  return "⚪";
}

// --- PUBLIC API (still sends, but controlled + deduped) ---

export async function sendTradeAlert(chatId, result, decision, errorMsg = null) {
  if (!bot) return;

  let msg;

  if (errorMsg || !result) {
    msg =
      `⚠️ *Trade Failed*\n\n` +
      `Confidence: ${(decision?.composite * 100 || 0).toFixed(1)}%\n` +
      `Error: ${esc(errorMsg || "Unknown")}`;
  } else {
    const { tradeRecord, quote } = result;
    const price = quote?.price || quote?.expectedPrice || 0;

    msg =
      `🎯 *Trade Executed*\n\n` +
      `Event: ${esc(tradeRecord.event_title)}\n` +
      `Side: ${esc(tradeRecord.side)} ${esc(tradeRecord.outcome)}\n` +
      `Amount: ${esc(tradeRecord.currency)} ${tradeRecord.amount}\n` +
      `Entry: ${(price * 100).toFixed(1)}¢\n\n` +
      `Composite: ${(decision.composite * 100).toFixed(0)}%`;
  }

  try {
    await bot.sendMessage(chatId, msg, { parse_mode: "MarkdownV2" });
  } catch (err) {
    console.error("[Alert] sendTradeAlert:", err.message);
  }
}

export async function broadcastSignals(signals) {
  if (!bot) return;

  const groups = await getGroups();
  if (!groups.length) return;

  const msg =
    `${signals.composite >= 0.65 ? "🔥 HOT" : "⚡ WARM"} *Signal Update*\n\n` +
    `Crypto ${emoji(signals.crypto.direction)} ${bar(signals.crypto.score)}\n` +
    `Sports ${emoji(signals.sports.direction)} ${bar(signals.sports.score)}\n` +
    `Sentiment ${emoji(signals.sentiment.direction)} ${bar(signals.sentiment.score)}\n\n` +
    `Composite ⚡ ${bar(signals.composite)}`;

  for (const g of groups) {
    const key = makeKey(g.group_id, msg);
    if (isDuplicate(key)) continue;

    try {
      await bot.sendMessage(g.group_id, msg, { parse_mode: "MarkdownV2" });
    } catch (err) {
      console.error("[Alert] broadcast:", err.message);
    }
  }
}
