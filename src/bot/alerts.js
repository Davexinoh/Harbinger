import { getGroups } from "../db/database.js";

let bot = null;

export function setBot(botInstance) {
  bot = botInstance;
}

function signalBar(score) {
  const filled = Math.round(score * 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  return `${bar} ${(score * 100).toFixed(0)}%`;
}

function directionEmoji(direction) {
  if (!direction) return "⚪";
  const d = direction.toLowerCase();
  if (d === "up" || d === "bullish" || d === "home") return "🟢";
  return "🔴";
}

export async function sendTradeAlert(chatId, result, signals, decision, errorMsg = null) {
  if (!bot) return;

  let msg;

  if (errorMsg || !result) {
    msg =
      `⚠️ *Trade Attempt Failed*\n\n` +
      `Composite confidence: \`${(decision.composite * 100).toFixed(1)}%\`\n` +
      `Error: ${errorMsg || "Unknown error"}\n\n` +
      `_Engine continues running._`;
  } else {
    const { tradeRecord, quote } = result;
    const { crypto, sports, sentiment } = signals;

    msg =
      `🎯 *Trade Executed*\n\n` +
      `📋 *Event:* ${tradeRecord.event_title}\n` +
      `📌 *Position:* ${tradeRecord.side} ${tradeRecord.outcome}\n` +
      `💰 *Amount:* ${tradeRecord.currency} ${tradeRecord.amount}\n` +
      `📈 *Entry Price:* ${(quote.expectedPrice * 100).toFixed(1)}¢\n` +
      `🧠 *Lead Signal:* ${tradeRecord.signal_source.toUpperCase()} (${(tradeRecord.confidence * 100).toFixed(0)}%)\n\n` +
      `*Signal Breakdown*\n` +
      `Crypto   ${directionEmoji(crypto.direction)} ${signalBar(crypto.score)}\n` +
      `Sports   ${directionEmoji(sports.direction)} ${signalBar(sports.score)}\n` +
      `Sentiment ${directionEmoji(sentiment.direction)} ${signalBar(sentiment.score)}\n` +
      `Composite ⚡ ${signalBar(decision.composite)}\n\n` +
      `_/trades to see full history_`;
  }

  await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
}

export async function sendSignalWarning(chatId, signal) {
  if (!bot) return;

  const emoji = signal.score >= 0.85 ? "🔥" : "⚡";
  const msg =
    `${emoji} *Signal Warming Up*\n\n` +
    `Source: *${signal.source.toUpperCase()}*\n` +
    `Score: \`${(signal.score * 100).toFixed(1)}%\`\n` +
    `Direction: ${directionEmoji(signal.direction)} ${signal.direction || "unknown"}\n\n` +
    `_Watching for threshold breach..._`;

  await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
}

export async function broadcastToGroups(signals) {
  if (!bot) return;

  const groups = getGroups();
  if (!groups.length) return;

  const { crypto, sports, sentiment, composite } = signals;

  // Only broadcast if something notable is happening (composite > 0.45)
  if (composite < 0.45) return;

  const intensity = composite >= 0.72 ? "🔥 HOT" : composite >= 0.60 ? "⚡ WARM" : "📡 ACTIVE";

  const msg =
    `${intensity} *Harbinger Signal Update*\n\n` +
    `Crypto   ${directionEmoji(crypto.direction)} ${signalBar(crypto.score)}\n` +
    `Sports   ${directionEmoji(sports.direction)} ${signalBar(sports.score)}\n` +
    `Sentiment ${directionEmoji(sentiment.direction)} ${signalBar(sentiment.score)}\n` +
    `━━━━━━━━━━━━━━\n` +
    `Composite ⚡ ${signalBar(composite)}\n\n` +
    (composite >= 0.72
      ? `🎯 *Threshold breached — trades may be executing for active users*\n\n`
      : "") +
    `_Start your own engine → @HarbingerBayseBot_`;

  for (const group of groups) {
    try {
      await bot.sendMessage(group.group_id, msg, { parse_mode: "Markdown" });
    } catch (err) {
      console.error(`[Alerts] Group ${group.group_id} send failed:`, err.message);
    }
  }
}
