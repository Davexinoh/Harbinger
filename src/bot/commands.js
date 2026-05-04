import {
  upsertUser,
  getUser,
  updateUser,
  upsertGroup,
  getRecentTrades,
  getPnL,
  getLeaderboard,
} from "../db/database.js";

import { encrypt, decrypt } from "../utils/encryption.js";
import { validateKeys, getEvents } from "../bayse/client.js";
import { runAllSignals } from "../engine/scorer.js";
import { getEngineStatus } from "../engine/engineLoop.js";

const SETUP = {
  PUB:      "pub",
  SEC:      "sec",
  THRESHOLD:"threshold",
  LIMIT:    "limit",
  CURRENCY: "currency",
  CATEGORY: "category",
};

const VALID_CATEGORIES = ["sports", "crypto", "politics", "entertainment", "finance", "all"];

function bar(score) {
  const filled = Math.round(score * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled) + ` ${(score * 100).toFixed(0)}%`;
}

function esc(text) {
  return String(text).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, "\\$&");
}

export function registerCommands(bot) {

  // ───────────────────────── START ─────────────────────────
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const isGroup = ["group", "supergroup"].includes(msg.chat.type);

    if (isGroup) {
      await upsertGroup(chatId, msg.chat.title, msg.from?.id);
      return bot.sendMessage(chatId,
        `📡 Bot active.\nSignals + crowd tracking enabled.\nUse DM for trading engine.`
      );
    }

    await upsertUser(chatId, msg.from?.username);
    const user = await getUser(chatId);
    const hasKeys = user?.bayse_pub_key && user?.bayse_sec_key;

    return bot.sendMessage(chatId,
      `Harbinger Engine\n\nSignal-driven prediction system.\n\n` +
      (hasKeys
        ? `Ready:\n /run — start engine\n /signals — live state\n /trades — history`
        : `Setup required:\n /connect — API keys\n /setup — configure engine\n /run — start`) +
      `\n\n /status — engine status\n /pnl — performance\n /markets — browse\n /category — set market type`
    );
  });

  // ───────────────────────── CONNECT ─────────────────────────
  bot.onText(/\/connect/, async (msg) => {
    const chatId = msg.chat.id;
    await updateUser(chatId, { setup_step: SETUP.PUB });
    return bot.sendMessage(chatId, `Send your Bayse PUBLIC key (pk_...)`);
  });

  // ───────────────────────── DISCONNECT ─────────────────────────
  bot.onText(/\/disconnect/, async (msg) => {
    const chatId = msg.chat.id;
    await updateUser(chatId, {
      bayse_pub_key: null,
      bayse_sec_key: null,
      engine_active: 0,
      setup_step: null,
    });
    return bot.sendMessage(chatId, `Keys removed. Engine stopped.\n\n/connect to reconnect.`);
  });

  // ───────────────────────── SETUP ─────────────────────────
  bot.onText(/\/setup/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    if (!user?.bayse_pub_key) {
      return bot.sendMessage(chatId, `Connect keys first with /connect`);
    }

    await updateUser(chatId, { setup_step: SETUP.THRESHOLD });
    return bot.sendMessage(chatId,
      `Threshold (0.5–0.95)\nCurrent: ${user.threshold || 0.6}\n\nSend a number:`
    );
  });

  // ───────────────────────── RUN ─────────────────────────
  bot.onText(/\/run/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    if (!user?.bayse_pub_key || !user?.bayse_sec_key) {
      return bot.sendMessage(chatId, `Missing keys. Run /connect first.`);
    }

    await updateUser(chatId, { engine_active: 1, setup_step: null });
    return bot.sendMessage(chatId, `✅ Engine started.\n\n/pause to pause | /stop to stop`);
  });

  // ───────────────────────── PAUSE ─────────────────────────
  bot.onText(/\/pause/, async (msg) => {
    await updateUser(msg.chat.id, { engine_active: 0 });
    return bot.sendMessage(msg.chat.id, `⏸ Engine paused.\n\n/resume to continue`);
  });

  // ───────────────────────── RESUME ─────────────────────────
  bot.onText(/\/resume/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    if (!user?.bayse_pub_key || !user?.bayse_sec_key) {
      return bot.sendMessage(chatId, `No keys connected. Run /connect first.`);
    }

    await updateUser(chatId, { engine_active: 1 });
    return bot.sendMessage(chatId, `▶️ Engine resumed.`);
  });

  // ───────────────────────── STOP ─────────────────────────
  bot.onText(/\/stop/, async (msg) => {
    await updateUser(msg.chat.id, { engine_active: 0, setup_step: null });
    return bot.sendMessage(msg.chat.id, `⏹ Engine stopped.\n\n/run to restart`);
  });

  // ───────────────────────── STATUS ─────────────────────────
  bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);
    const engine = getEngineStatus();

    const cat = user?.preferred_category || "all";
    const currency = user?.currency || "USD";

    return bot.sendMessage(chatId,
      `Status\n\n` +
      `Engine: ${user?.engine_active ? "ON ▶️" : "OFF ⏹"}\n` +
      `Threshold: ${user?.threshold || 0.6}\n` +
      `Max trade: ${currency} ${user?.max_trade_amount || "—"}\n` +
      `Category: ${cat}\n` +
      `Currency: ${currency}\n` +
      `Active users: ${engine.activeUsers}`
    );
  });

  // ───────────────────────── SIGNALS ─────────────────────────
  bot.onText(/\/signals/, async (msg) => {
    const chatId = msg.chat.id;

    await bot.sendMessage(chatId, `Fetching signals...`);

    try {
      const signals = await runAllSignals();

      return bot.sendMessage(chatId,
        `Signal Report\n\n` +
        `BTC 15m  ${bar(signals.btc15m?.score ?? 0.5)}\n` +
        `Crypto   ${bar(signals.crypto?.score ?? 0.5)}\n` +
        `Sports   ${bar(signals.sports?.score ?? 0.5)}\n` +
        `Sentiment ${bar(signals.sentiment?.score ?? 0.5)}`
      );
    } catch (err) {
      return bot.sendMessage(chatId, `Failed to fetch signals: ${err.message}`);
    }
  });

  // ───────────────────────── TRADES ─────────────────────────
  bot.onText(/\/trades/, async (msg) => {
    const chatId = msg.chat.id;

    try {
      const trades = await getRecentTrades(String(chatId), 10);

      if (!trades?.length) {
        return bot.sendMessage(chatId, `No trades yet.\n\n/run to start the engine.`);
      }

      const lines = trades.map((t, i) => {
        const status = t.status === "won" ? "✅" : t.status === "lost" ? "❌" : "⏳";
        const pnl = t.pnl != null ? ` | ${t.pnl > 0 ? "+" : ""}${t.pnl}` : "";
        return `${i + 1}. ${status} ${esc(t.event_title?.slice(0, 35))}\n   ${t.side} ${t.amount} ${t.currency}${pnl}`;
      });

      return bot.sendMessage(chatId,
        `Recent Trades\n\n${lines.join("\n\n")}\n\n/pnl for performance summary`
      );
    } catch (err) {
      return bot.sendMessage(chatId, `Error fetching trades: ${err.message}`);
    }
  });

  // ───────────────────────── PNL ─────────────────────────
  bot.onText(/\/pnl/, async (msg) => {
    const chatId = msg.chat.id;

    try {
      const pnl = await getPnL(String(chatId));

      if (!pnl) {
        return bot.sendMessage(chatId, `No trade data yet.`);
      }

      const winRate = pnl.total > 0
        ? ((pnl.wins / pnl.total) * 100).toFixed(1)
        : "0.0";

      return bot.sendMessage(chatId,
        `Performance\n\n` +
        `Total trades: ${pnl.total || 0}\n` +
        `Wins: ${pnl.wins || 0} | Losses: ${pnl.losses || 0}\n` +
        `Win rate: ${winRate}%\n` +
        `Net P&L: ${pnl.net > 0 ? "+" : ""}${(pnl.net || 0).toFixed(2)} ${pnl.currency || "USD"}`
      );
    } catch (err) {
      return bot.sendMessage(chatId, `Error fetching P&L: ${err.message}`);
    }
  });

  // ───────────────────────── THRESHOLD ─────────────────────────
  bot.onText(/\/threshold/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    await updateUser(chatId, { setup_step: SETUP.THRESHOLD });
    return bot.sendMessage(chatId,
      `Set confidence threshold (0.5–0.95)\nCurrent: ${user?.threshold || 0.6}\n\nSend a number:`
    );
  });

  // ───────────────────────── LIMIT ─────────────────────────
  bot.onText(/\/limit/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);
    const currency = user?.currency || "USD";

    await updateUser(chatId, { setup_step: SETUP.LIMIT });
    return bot.sendMessage(chatId,
      `Set max trade amount (${currency})\nCurrent: ${user?.max_trade_amount || "—"}\n\nSend a number:`
    );
  });

  // ───────────────────────── CATEGORY ─────────────────────────
  bot.onText(/\/category/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);
    const current = user?.preferred_category || "all";

    await updateUser(chatId, { setup_step: SETUP.CATEGORY });

    return bot.sendMessage(chatId,
      `Set market category\nCurrent: ${current}\n\n` +
      `Options:\n` +
      VALID_CATEGORIES.map((c, i) => `${i + 1}. ${c}`).join("\n") +
      `\n\nSend the category name:`
    );
  });

  // ───────────────────────── MARKETS ─────────────────────────
  bot.onText(/\/markets/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    await bot.sendMessage(chatId, `Fetching open markets...`);

    try {
      const pubKey = user?.bayse_pub_key ? decrypt(user.bayse_pub_key) : null;
      const category = user?.preferred_category !== "all" ? user?.preferred_category : undefined;
      const events = await getEvents(pubKey, { status: "open", size: 10, category });

      if (!events?.length) {
        return bot.sendMessage(chatId, `No open markets found.`);
      }

      const lines = events.slice(0, 8).map((e, i) => {
        const market = e.markets?.find(m => m.status === "open");
        const yes = market?.outcome1Price != null
          ? `${(market.outcome1Price * 100).toFixed(0)}¢`
          : "—";
        const no = market?.outcome2Price != null
          ? `${(market.outcome2Price * 100).toFixed(0)}¢`
          : "—";
        return `${i + 1}. ${esc(e.title?.slice(0, 45))}\n   YES ${yes} | NO ${no}`;
      });

      return bot.sendMessage(chatId,
        `Open Markets\n\n${lines.join("\n\n")}\n\n/hot for most active`
      );
    } catch (err) {
      return bot.sendMessage(chatId, `Error fetching markets: ${err.message}`);
    }
  });

  // ───────────────────────── HOT ─────────────────────────
  bot.onText(/\/hot/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    await bot.sendMessage(chatId, `Finding hottest markets...`);

    try {
      const pubKey = user?.bayse_pub_key ? decrypt(user.bayse_pub_key) : null;
      const events = await getEvents(pubKey, { status: "open", size: 50 });

      if (!events?.length) {
        return bot.sendMessage(chatId, `No open markets found.`);
      }

      // Sort by total order volume as proxy for activity
      const sorted = events
        .filter(e => e.markets?.some(m => m.status === "open"))
        .sort((a, b) => (b.totalOrders || 0) - (a.totalOrders || 0))
        .slice(0, 6);

      const lines = sorted.map((e, i) => {
        const market = e.markets?.find(m => m.status === "open");
        const yes = market?.outcome1Price != null
          ? `${(market.outcome1Price * 100).toFixed(0)}¢`
          : "—";
        const no = market?.outcome2Price != null
          ? `${(market.outcome2Price * 100).toFixed(0)}¢`
          : "—";
        const orders = e.totalOrders || 0;
        return `${i + 1}. ${esc(e.title?.slice(0, 45))}\n   YES ${yes} | NO ${no} | ${orders} orders`;
      });

      return bot.sendMessage(chatId, `Hottest Markets\n\n${lines.join("\n\n")}`);
    } catch (err) {
      return bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // ───────────────────────── LEADERBOARD ─────────────────────────
  bot.onText(/\/leaderboard/, async (msg) => {
    const chatId = msg.chat.id;

    try {
      const board = await getLeaderboard(10);

      if (!board?.length) {
        return bot.sendMessage(chatId, `No leaderboard data yet.`);
      }

      const lines = board.map((entry, i) => {
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
        const winRate = entry.total > 0
          ? ((entry.wins / entry.total) * 100).toFixed(1)
          : "0.0";
        const name = entry.username ? `@${esc(entry.username)}` : `User ${String(entry.chat_id).slice(-4)}`;
        return `${medal} ${name}\n   ${winRate}% win rate | ${entry.total} trades`;
      });

      return bot.sendMessage(chatId, `Leaderboard\n\n${lines.join("\n\n")}`);
    } catch (err) {
      return bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // ───────────────────────── CANCEL ─────────────────────────
  bot.onText(/\/cancel/, async (msg) => {
    const chatId = msg.chat.id;
    await updateUser(chatId, { setup_step: null });
    return bot.sendMessage(chatId, `Cancelled.`);
  });

  // ─────────────────── SINGLE MESSAGE HANDLER ───────────────────
  // One handler for ALL plain-text flows — setup, category, limit, threshold.
  // Keeps state isolated. marketMakerCommands.js handles mm_awaiting_market separately.
  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;

    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    if (!user?.setup_step) return;

    // Don't intercept market maker step — let marketMakerCommands handle it
    if (user.setup_step === "mm_awaiting_market") return;

    const text = msg.text.trim();

    switch (user.setup_step) {

      case SETUP.PUB: {
        if (!text.startsWith("pk_")) {
          return bot.sendMessage(chatId, `Invalid. Must start with pk_`);
        }
        await updateUser(chatId, {
          bayse_pub_key: encrypt(text),
          setup_step: SETUP.SEC,
        });
        return bot.sendMessage(chatId, `Got it. Now send your SECRET key (sk_...)`);
      }

      case SETUP.SEC: {
        if (!text.startsWith("sk_")) {
          return bot.sendMessage(chatId, `Invalid. Must start with sk_`);
        }
        const pub = decrypt(user.bayse_pub_key);
        const valid = await validateKeys(pub, text);

        if (!valid.valid) {
          return bot.sendMessage(chatId, `Key validation failed. Check your keys and try /connect again.`);
        }

        await updateUser(chatId, {
          bayse_sec_key: encrypt(text),
          setup_step: null,
        });
        return bot.sendMessage(chatId, `✅ Keys saved.\n\nRun /setup to configure your engine.`);
      }

      case SETUP.THRESHOLD: {
        const val = parseFloat(text);
        if (isNaN(val) || val < 0.5 || val > 0.95) {
          return bot.sendMessage(chatId, `Must be between 0.5 and 0.95`);
        }
        await updateUser(chatId, {
          threshold: val,
          setup_step: SETUP.LIMIT,
        });
        return bot.sendMessage(chatId, `Threshold set to ${val}.\n\nNow set max trade amount:`);
      }

      case SETUP.LIMIT: {
        const amt = parseFloat(text);
        if (isNaN(amt) || amt < 1) {
          return bot.sendMessage(chatId, `Must be >= 1`);
        }
        await updateUser(chatId, {
          max_trade_amount: amt,
          setup_step: SETUP.CURRENCY,
        });
        return bot.sendMessage(chatId, `Max trade set to ${amt}.\n\nCurrency? Send USD or NGN:`);
      }

      case SETUP.CURRENCY: {
        const cur = text.toUpperCase();
        if (!["USD", "NGN"].includes(cur)) {
          return bot.sendMessage(chatId, `USD or NGN only`);
        }
        await updateUser(chatId, {
          currency: cur,
          setup_step: SETUP.CATEGORY,
        });
        return bot.sendMessage(chatId,
          `Currency set to ${cur}.\n\nPreferred market category?\n\n` +
          VALID_CATEGORIES.map((c, i) => `${i + 1}. ${c}`).join("\n") +
          `\n\nSend category name:`
        );
      }

      case SETUP.CATEGORY: {
        const cat = text.toLowerCase();
        if (!VALID_CATEGORIES.includes(cat)) {
          return bot.sendMessage(chatId,
            `Invalid. Options: ${VALID_CATEGORIES.join(", ")}`
          );
        }
        await updateUser(chatId, {
          preferred_category: cat,
          setup_step: null,
        });
        return bot.sendMessage(chatId,
          `✅ Setup complete.\n\nCategory: ${cat}\n\n/run to start the engine.`
        );
      }
    }
  });
}
