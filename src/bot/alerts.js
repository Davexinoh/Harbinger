import { getGroups } from "../db/database.js";
import { postCrowdPoll } from "../signals/crowdSignal.js";

let bot = null;

export function setBot(botInstance) {
  bot = botInstance;
}

function signalBar(score) {
  const filled = Math.round(score * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled) + ` ${(score * 100).toFixed(0)}%`;
}

function directionEmoji(direction) {
  if (!direction) return "⚪";
  const d = direction.toLowerCase();
  if (d === "up" || d === "bullish" || d === "yes" || d === "home") return "🟢";
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
    const price = quote.price || quote.expectedPrice;

    msg =
      `🎯 *Trade Executed*\n\n` +
      `📋 *Event:* ${tradeRecord.event_title}\n` +
      `📌 *Position:* ${tradeRecord.side} ${tradeRecord.outcome}\n` +
      `💰 *Amount:* ${tradeRecord.currency} ${tradeRecord.amount}\n` +
      `📈 *Entry Price:* ${(price * 100).toFixed(1)}¢\n` +
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

export async function broadcastToGroups(signals, forcePoll = false) {
  if (!bot) return;

  const groups = getGroups();
  if (!groups.length) return;

  const { crypto, sports, sentiment, composite } = signals;

  // If forcePoll — post a fresh crowd poll instead of a signal broadcast
  if (forcePoll && composite >= 0.55) {
    try {
      await postCrowdPoll(signals, null);
    } catch (err) {
      console.error("[Alerts] Force poll error:", err.message);
    }
    return;
  }

  // Signal broadcast only when composite is meaningfully elevated
  if (composite < 0.60) return;

  const intensity = composite >= 0.65 ? "🔥 HOT" : "⚡ WARM";

  const msg =
    `${intensity} *Harbinger Signal Update*\n\n` +
    `Crypto   ${directionEmoji(crypto.direction)} ${signalBar(crypto.score)}\n` +
    `Sports   ${directionEmoji(sports.direction)} ${signalBar(sports.score)}\n` +
    `Sentiment ${directionEmoji(sentiment.direction)} ${signalBar(sentiment.score)}\n` +
    `━━━━━━━━━━━━━━\n` +
    `Composite ⚡ ${signalBar(composite)}\n\n` +
    (composite >= 0.65 ? `🎯 *Threshold breached — trades may be executing*\n\n` : "") +
    `_Start your own engine → @Harbingerbayse_bot_`;

  for (const group of groups) {
    try {
      await bot.sendMessage(group.group_id, msg, { parse_mode: "Markdown" });
    } catch (err) {
      console.error(`[Alerts] Group ${group.group_id} send failed:`, err.message);
    }
  }
}
