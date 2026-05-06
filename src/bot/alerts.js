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
