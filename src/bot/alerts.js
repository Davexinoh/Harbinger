let bot = null;
export function setBot(b) { bot = b; }

export async function sendAlert(chatId, text) {
  if (!bot) return;
  try {
    await bot.sendMessage(chatId, text);
  } catch (err) {
    console.error("[Alert] Failed:", err.message);
  }
}

export async function sendTradeExecuted(chatId, { title, direction, amount, outcomeLabel, composite }) {
  if (!bot) return;
  const dir = direction === "YES" ? "↑ YES" : "↓ NO";
  try {
    await bot.sendMessage(chatId,
      `✅ HARBINGER  //  trade executed\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `${title}\n\n` +
      `Direction    ${dir}\n` +
      `Fill         ${outcomeLabel || direction}\n` +
      `Amount       ₦${amount}\n\n` +
      `Composite    ${(composite * 100).toFixed(0)}%\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `→ /trades to track this position`
    );
  } catch (err) {
    console.error("[Alert] sendTradeExecuted failed:", err.message);
  }
}

export async function sendTradeFailed(chatId, { composite, error }) {
  if (!bot) return;
  try {
    await bot.sendMessage(chatId,
      `⚠️ HARBINGER  //  trade failed\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Confidence    ${(composite * 100).toFixed(0)}%\n` +
      `Error         ${error}\n\n` +
      `Engine continues running.`
    );
  } catch (err) {
    console.error("[Alert] sendTradeFailed failed:", err.message);
  }
}

export async function sendTradeSettled(chatId, { title, outcome, amount, pnl, currency = "NGN" }) {
  if (!bot) return;
  const won     = pnl > 0;
  const pushed  = pnl === 0;
  const icon    = won ? "✅" : pushed ? "⚪" : "❌";
  const result  = won ? "WON" : pushed ? "PUSHED" : "LOST";
  const pnlSign = pnl >= 0 ? "+" : "";

  try {
    await bot.sendMessage(chatId,
      `${icon} HARBINGER  //  trade settled\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `${title}\n\n` +
      `Outcome      ${outcome}\n` +
      `Amount       ₦${amount}\n` +
      `Result       ${result}\n` +
      `P&L          ${pnlSign}₦${Math.abs(pnl).toFixed(2)}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `→ /pnl for full performance`
    );
  } catch (err) {
    console.error("[Alert] sendTradeSettled failed:", err.message);
  }
}

export async function sendSignalBroadcast(chatId, signals) {
  if (!bot) return;
  const comp  = signals.composite;
  const state = comp >= 0.75 ? "🔥 HOT — trade incoming" 
    : comp >= 0.6 ? "⚡ WARM — watching closely" 
    : "◼ MONITORING";

  function bar(score = 0.5) {
    const f = Math.round(Math.max(0, Math.min(1, score)) * 10);
    return "█".repeat(f) + "░".repeat(10 - f) + ` ${(score * 100).toFixed(0)}%`;
  }

  function arrow(d) {
    if (!d) return "→";
    const u = d.toUpperCase();
    if (["UP","YES","BULLISH"].includes(u)) return "↑";
    if (["DOWN","NO","BEARISH"].includes(u)) return "↓";
    return "→";
  }

  try {
    await bot.sendMessage(chatId,
      `⚡ HARBINGER  //  signal update\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Crypto    ${bar(signals.crypto?.score)}  ${arrow(signals.crypto?.direction)}\n` +
      `BTC 15m   ${bar(signals.btc15m?.score)}  ${arrow(signals.btc15m?.direction)}\n` +
      `Sentiment ${bar(signals.sentiment?.score)}  ${arrow(signals.sentiment?.direction)}\n` +
      `Sports    ${bar(signals.sports?.score)}  ${arrow(signals.sports?.direction)}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Composite ${bar(comp)}\n\n` +
      `${state}`
    );
  } catch (err) {
    console.error("[Alert] sendSignalBroadcast failed:", err.message);
  }
}
