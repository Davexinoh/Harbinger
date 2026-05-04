import {
  upsertUser,
  getUser,
  updateUser,
  upsertGroup,
  removeGroup,
  getRecentTrades,
  getPnL,
  getLeaderboard,
} from "../db/database.js";

import { encrypt, decrypt } from "../utils/encryption.js";
import { validateKeys, getEvents } from "../bayse/client.js";
import { runAllSignals } from "../engine/scorer.js";
import { getEngineStatus } from "../engine/engineLoop.js";

const SETUP = {
  PUB: "pub",
  SEC: "sec",
  THRESHOLD: "threshold",
  LIMIT: "limit",
  CURRENCY: "currency",
  CATEGORY: "category",
};

const VALID_CATEGORIES = ["sports", "crypto", "politics", "entertainment", "finance", "all"];

/**
 * CRITICAL FIX:
 * Do NOT reuse setup_step for trade flows.
 * Use isolated memory state instead.
 */
const tradeSession = new Map();

function bar(score) {
  const filled = Math.round(score * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled) + ` ${(score * 100).toFixed(0)}%`;
}

export function registerCommands(bot) {

  // ───────────────────────── START ─────────────────────────
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const isGroup = ["group", "supergroup"].includes(msg.chat.type);

    if (isGroup) {
      await upsertGroup(chatId, msg.chat.title, msg.from?.id);

      return bot.sendMessage(
        chatId,
        `📡 Bot active.\nSignals + crowd tracking enabled.\nUse DM for trading engine.`,
      );
    }

    await upsertUser(chatId, msg.from?.username);
    const user = await getUser(chatId);

    const hasKeys = user?.bayse_pub_key && user?.bayse_sec_key;

    return bot.sendMessage(
      chatId,
      `Harbinger Engine

Signal-driven prediction system.

${hasKeys
  ? `Ready:
 /run - start engine
 /signals - live state
 /trades - history`
  : `Setup required:
 /connect - API keys
 /setup - configure engine
 /run - start`}

 /status - engine status
 /pnl - performance
 /markets - browse`,
    );
  });

  // ───────────────────────── CONNECT ─────────────────────────
  bot.onText(/\/connect/, async (msg) => {
    const chatId = msg.chat.id;

    await updateUser(chatId, { setup_step: SETUP.PUB });

    return bot.sendMessage(chatId,
      `Send PUBLIC key (pk_...)`
    );
  });

  // ───────────────────────── SETUP ─────────────────────────
  bot.onText(/\/setup/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    if (!user?.bayse_pub_key) {
      return bot.sendMessage(chatId, `Connect keys first.`);
    }

    await updateUser(chatId, { setup_step: SETUP.THRESHOLD });

    return bot.sendMessage(chatId,
      `Threshold (0.5 - 0.95)\nCurrent: ${user.threshold || 0.6}`
    );
  });

  // ───────────────────────── RUN ─────────────────────────
  bot.onText(/\/run/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    if (!user?.bayse_pub_key || !user?.bayse_sec_key) {
      return bot.sendMessage(chatId, `Missing keys.`);
    }

    await updateUser(chatId, { engine_active: 1 });

    return bot.sendMessage(chatId, `Engine started.`);
  });

  // ───────────────────────── PAUSE ─────────────────────────
  bot.onText(/\/pause/, async (msg) => {
    await updateUser(msg.chat.id, { engine_active: 0 });
    return bot.sendMessage(msg.chat.id, `Paused.`);
  });

  // ───────────────────────── STATUS ─────────────────────────
  bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);
    const engine = getEngineStatus();

    return bot.sendMessage(chatId,
      `Status:
Engine: ${user?.engine_active ? "ON" : "OFF"}
Threshold: ${user?.threshold || 0.6}
Active users: ${engine.activeUsers}`
    );
  });

  // ───────────────────────── SIGNALS ─────────────────────────
  bot.onText(/\/signals/, async (msg) => {
    const chatId = msg.chat.id;

    const signals = await runAllSignals();

    return bot.sendMessage(chatId,
      `BTC: ${bar(signals.btc15m.score)}
Crypto: ${bar(signals.crypto.score)}
Sports: ${bar(signals.sports.score)}
Sentiment: ${bar(signals.sentiment.score)}`
    );
  });

  // ───────────────────────── SAFE MESSAGE HANDLER ─────────────────────────
  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;

    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    if (!user?.setup_step) return;

    const text = msg.text.trim();

    switch (user.setup_step) {

      case SETUP.PUB:
        if (!text.startsWith("pk_")) {
          return bot.sendMessage(chatId, `Invalid public key`);
        }
        await updateUser(chatId, {
          bayse_pub_key: encrypt(text),
          setup_step: SETUP.SEC,
        });
        return bot.sendMessage(chatId, `Now send secret key`);

      case SETUP.SEC:
        if (!text.startsWith("sk_")) {
          return bot.sendMessage(chatId, `Invalid secret key`);
        }

        const pub = decrypt(user.bayse_pub_key);
        const valid = await validateKeys(pub, text);

        if (!valid.valid) {
          return bot.sendMessage(chatId, `Key validation failed`);
        }

        await updateUser(chatId, {
          bayse_sec_key: encrypt(text),
          setup_step: null,
        });

        return bot.sendMessage(chatId, `Keys saved`);

      case SETUP.THRESHOLD:
        const val = parseFloat(text);
        if (isNaN(val) || val < 0.5 || val > 0.95) {
          return bot.sendMessage(chatId, `0.5 - 0.95 only`);
        }

        await updateUser(chatId, {
          threshold: val,
          setup_step: SETUP.LIMIT,
        });

        return bot.sendMessage(chatId, `Set max trade`);

      case SETUP.LIMIT:
        const amt = parseFloat(text);
        if (isNaN(amt) || amt < 1) {
          return bot.sendMessage(chatId, `Must be >= 1`);
        }

        await updateUser(chatId, {
          max_trade_usd: amt,
          setup_step: SETUP.CURRENCY,
        });

        return bot.sendMessage(chatId, `USD or NGN?`);

      case SETUP.CURRENCY:
        if (!["USD", "NGN"].includes(text.toUpperCase())) {
          return bot.sendMessage(chatId, `USD or NGN only`);
        }

        await updateUser(chatId, {
          currency: text.toUpperCase(),
          setup_step: null,
        });

        return bot.sendMessage(chatId, `Setup complete`);

    }
  });

}
