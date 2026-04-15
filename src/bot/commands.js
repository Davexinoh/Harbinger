import {
  upsertUser,
  getUser,
  updateUser,
  upsertGroup,
  removeGroup,
  getRecentTrades,
  getPnL,
} from "../db/database.js";
import { encrypt, decrypt } from "../utils/encryption.js";
import { validateKeys, getEvents, readRequest } from "../bayse/client.js";
import { runAllSignals } from "../engine/scorer.js";
import { getEngineStatus } from "../engine/engineLoop.js";

const SETUP_STEPS = {
  AWAITING_PUB_KEY: "awaiting_pub_key",
  AWAITING_SEC_KEY: "awaiting_sec_key",
  AWAITING_THRESHOLD: "awaiting_threshold",
  AWAITING_MAX_AMOUNT: "awaiting_max_amount",
  AWAITING_LIMIT_UPDATE: "awaiting_limit_update",
  AWAITING_THRESHOLD_UPDATE: "awaiting_threshold_update",
};

function signalBar(score) {
  const filled = Math.round(score * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled) + ` ${(score * 100).toFixed(0)}%`;
}

export function registerCommands(bot) {
  // ─── /start ─────────────────────────────────────────────────────────────────
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";

    if (isGroup) {
      upsertGroup(chatId, msg.chat.title, msg.from?.id);
      return bot.sendMessage(
        chatId,
        `📡 *Harbinger is now active in this group*\n\n` +
        `I'll broadcast live signal updates whenever markets heat up.\n\n` +
        `Trade alerts and P&L are private — each user runs their own engine via DM.\n\n` +
        `_Start your personal engine → message me directly_`,
        { parse_mode: "Markdown" }
      );
    }

    upsertUser(chatId, msg.from?.username);
    const user = getUser(chatId);

    const hasKeys = user?.bayse_pub_key && user?.bayse_sec_key;


    return bot.sendMessage(
      chatId,
      `🔮 *Harbinger*\n` +
      `_The market moves. We saw it coming._\n\n` +
      `Three signals. One engine. Fully autonomous.\n\n` +
      `Harbinger watches crypto momentum, football form, and live news — then trades Bayse prediction markets the moment signals converge. No charts. No clicking. Just results.\n\n` +
      (hasKeys
        ? `Keys connected. Pick up where you left off:\n` +
          `/run — fire the engine\n` +
          `/signals — live signal scores right now\n` +
          `/trades — your trade history\n\n`
        : `Get started:\n` +
          `/connect — link your Bayse account\n` +
          `/setup — set threshold and trade size\n` +
          `/run — engine takes over\n\n`) +
      `/trade — place a manual trade\n` +
      `/markets — browse open markets\n` +
      `/hot — markets with active signals\n` +
      `/pnl — your P\\&L\n` +
      `/crowdiq — crowd wisdom accuracy\n` +
      `/status — engine state`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── /connect ────────────────────────────────────────────────────────────────
  bot.onText(/\/connect/, async (msg) => {
    const chatId = msg.chat.id;
    upsertUser(chatId, msg.from?.username);
    updateUser(chatId, { setup_step: SETUP_STEPS.AWAITING_PUB_KEY });

    return bot.sendMessage(
      chatId,
      `🔑 *Connect Your Bayse Account*\n\n` +
      `You'll need API keys from Bayse. Get them at:\n` +
      `1. Log in at bayse.markets\n` +
      `2. Go to Settings → API Keys\n` +
      `3. Create a new key pair\n\n` +
      `*Step 1/2 — Paste your Public Key* (starts with \`pk_live_\`)\n\n` +
      `⚠️ _Your keys are encrypted and stored only on this server. Never shared._`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── /setup ──────────────────────────────────────────────────────────────────
  bot.onText(/\/setup/, async (msg) => {
    const chatId = msg.chat.id;
    const user = getUser(chatId);

    if (!user?.bayse_pub_key) {
      return bot.sendMessage(chatId, `❌ Connect your Bayse keys first with /connect`);
    }

    updateUser(chatId, { setup_step: SETUP_STEPS.AWAITING_THRESHOLD });

    return bot.sendMessage(
      chatId,
      `⚙️ *Engine Setup*\n\n` +
      `*Step 1/2 — Confidence Threshold*\n\n` +
      `This is the minimum signal score (0–1) required before the engine trades.\n\n` +
      `• \`0.65\` — more trades, more risk\n` +
      `• \`0.72\` — balanced (recommended)\n` +
      `• \`0.85\` — conservative, fewer trades\n\n` +
      `Current: \`${user.threshold || 0.72}\`\n\n` +
      `_Send a number between 0.5 and 0.95_`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── /run ────────────────────────────────────────────────────────────────────
  bot.onText(/\/run/, async (msg) => {
    const chatId = msg.chat.id;
    const user = getUser(chatId);

    if (!user?.bayse_pub_key || !user?.bayse_sec_key) {
      return bot.sendMessage(chatId, `❌ Connect your Bayse keys first with /connect`);
    }

    updateUser(chatId, { engine_active: 1 });

    return bot.sendMessage(
      chatId,
      `🟢 *Engine Started*\n\n` +
      `Harbinger is now running for your account.\n\n` +
      `📊 Signals evaluated every minute\n` +
      `🎯 Threshold: \`${user.threshold}\`\n` +
      `💰 Max trade: \`${user.currency || "USD"} ${user.max_trade_usd}\`\n\n` +
      `I'll message you the moment I fire a trade.\n\n` +
      `_/pause to stop | /status to check in_`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── /pause ──────────────────────────────────────────────────────────────────
  bot.onText(/\/pause/, async (msg) => {
    const chatId = msg.chat.id;
    updateUser(chatId, { engine_active: 0 });
    return bot.sendMessage(
      chatId,
      `⏸ *Engine Paused*\n\nNo trades will fire. Type /resume to restart.`
    );
  });

  // ─── /resume ─────────────────────────────────────────────────────────────────
  bot.onText(/\/resume/, async (msg) => {
    const chatId = msg.chat.id;
    const user = getUser(chatId);
    if (!user?.bayse_pub_key) {
      return bot.sendMessage(chatId, `❌ Connect your keys first with /connect`);
    }
    updateUser(chatId, { engine_active: 1 });
    return bot.sendMessage(chatId, `▶️ *Engine Resumed*\n\nBack to watching signals.`, {
      parse_mode: "Markdown",
    });
  });

  // ─── /stop ───────────────────────────────────────────────────────────────────
  bot.onText(/\/stop/, async (msg) => {
    const chatId = msg.chat.id;
    updateUser(chatId, { engine_active: 0 });
    return bot.sendMessage(
      chatId,
      `🔴 *Engine Stopped*\n\nHarbinger is no longer trading for your account. Your keys remain saved.\n\n_/run to restart_`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── /status ─────────────────────────────────────────────────────────────────
  bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const user = getUser(chatId);
    const engine = getEngineStatus();

    const hasKeys = user?.bayse_pub_key && user?.bayse_sec_key;
    const engineState = user?.engine_active ? "🟢 Running" : "🔴 Paused";

    return bot.sendMessage(
      chatId,
      `📊 *Harbinger Status*\n\n` +
      `Engine: ${engineState}\n` +
      `Keys: ${hasKeys ? "✅ Connected" : "❌ Not connected"}\n` +
      `Threshold: \`${user?.threshold || 0.72}\`\n` +
      `Max Trade: \`${user?.currency || "USD"} ${user?.max_trade_usd || 5}\`\n\n` +
      `*Global Engine*\n` +
      `Active users: ${engine.activeUsers}\n` +
      `Tick interval: ${engine.tickIntervalMs / 1000}s\n\n` +
      `_/signals for live signal scores_`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── /signals ────────────────────────────────────────────────────────────────
  bot.onText(/\/signals/, async (msg) => {
    const chatId = msg.chat.id;

    await bot.sendMessage(chatId, `🔄 _Fetching live signals..._`, {
      parse_mode: "Markdown",
    });

    try {
      const signals = await runAllSignals();
      const { crypto, sports, sentiment, composite } = signals;

      const status = composite >= 0.72 ? "🔥 THRESHOLD BREACH" : composite >= 0.60 ? "⚡ WARMING UP" : "📡 MONITORING";

      return bot.sendMessage(
        chatId,
        `📡 *Live Signal Report*\n\n` +
        `*Crypto* ${crypto.direction ? (crypto.direction === "UP" ? "🟢" : "🔴") : "⚪"}\n` +
        `${signalBar(crypto.score)}\n` +
        `${crypto.best ? `${crypto.best.symbol} ${crypto.best.change1h}% (1h) | ${crypto.best.change24h}% (24h)` : crypto.error || "No data"}\n\n` +
        `*Sports* ${sports.direction === "home" ? "🟢" : sports.direction ? "🔴" : "⚪"}\n` +
        `${signalBar(sports.score)}\n` +
        `${sports.best ? `${sports.best.homeTeam} vs ${sports.best.awayTeam}` : sports.reason || "No fixtures"}\n\n` +
        `*Sentiment* ${sentiment.direction === "bullish" ? "🟢" : sentiment.direction ? "🔴" : "⚪"}\n` +
        `${signalBar(sentiment.score)}\n` +
        `${sentiment.best ? `"${sentiment.best.title.slice(0, 60)}..."` : sentiment.reason || "No headlines"}\n\n` +
        `━━━━━━━━━━━━━━\n` +
        `*Composite* ⚡\n` +
        `${signalBar(composite)}\n\n` +
        `${status}\n\n` +
        `_Updated: ${new Date().toUTCString()}_`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      return bot.sendMessage(chatId, `❌ Signal fetch failed: ${err.message}`);
    }
  });

  // ─── /trades ─────────────────────────────────────────────────────────────────
  bot.onText(/\/trades/, async (msg) => {
    const chatId = msg.chat.id;
    const trades = getRecentTrades(chatId, 10);

    if (!trades.length) {
      return bot.sendMessage(
        chatId,
        `📋 *No trades yet*\n\nStart the engine with /run to begin trading.`,
        { parse_mode: "Markdown" }
      );
    }

    const lines = trades.map((t, i) => {
      const status = t.status === "resolved" ? (t.pnl > 0 ? "✅" : "❌") : "⏳";
      const pnl = t.pnl != null ? ` | P&L: ${t.pnl > 0 ? "+" : ""}${t.pnl?.toFixed(2)}` : "";
      return `${i + 1}. ${status} *${t.event_title.slice(0, 35)}*\n   ${t.side} ${t.outcome} | ${t.currency} ${t.amount} | ${t.signal_source}${pnl}`;
    });

    return bot.sendMessage(
      chatId,
      `📋 *Recent Trades*\n\n${lines.join("\n\n")}`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── /pnl ────────────────────────────────────────────────────────────────────
  bot.onText(/\/pnl/, async (msg) => {
    const chatId = msg.chat.id;
    const stats = getPnL(chatId);

    if (!stats || stats.total_trades === 0) {
      return bot.sendMessage(
        chatId,
        `📈 *No resolved trades yet*\n\nP&L tracks once markets resolve. Keep the engine running.`,
        { parse_mode: "Markdown" }
      );
    }

    const winRate = stats.total_trades > 0 ? (stats.wins / stats.total_trades) * 100 : 0;
    const pnlEmoji = stats.total_pnl >= 0 ? "🟢" : "🔴";

    return bot.sendMessage(
      chatId,
      `📈 *Your P&L Summary*\n\n` +
      `Total Trades: \`${stats.total_trades}\`\n` +
      `Wins / Losses: \`${stats.wins} / ${stats.losses}\`\n` +
      `Win Rate: \`${winRate.toFixed(1)}%\`\n` +
      `Total P&L: ${pnlEmoji} \`${stats.total_pnl >= 0 ? "+" : ""}${stats.total_pnl.toFixed(2)}\`\n` +
      `Avg Confidence: \`${(stats.avg_confidence * 100).toFixed(0)}%\`\n\n` +
      `_/trades for full trade history_`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── /markets ────────────────────────────────────────────────────────────────
  bot.onText(/\/markets/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, `🔄 _Fetching open markets..._`, {
      parse_mode: "Markdown",
    });

    try {
      const user = getUser(chatId);
      const pubKey = decrypt(user?.bayse_pub_key);
      if (!pubKey) return bot.sendMessage(chatId, `❌ Connect your Bayse keys first with /connect`);
      const events = await getEvents(pubKey, { status: "open", size: 10 });

      if (!events.length) {
        return bot.sendMessage(chatId, `📭 No open markets found right now.`);
      }

      const lines = events.slice(0, 8).map((e, i) => {
        const engine = e.engine ? ` \\[${e.engine}\\]` : "";
        const markets = e.markets?.length ? ` • ${e.markets.length} market(s)` : "";
        return `${i + 1}. *${e.title?.slice(0, 45)}*${engine}${markets}`;
      });

      return bot.sendMessage(
        chatId,
        `🏪 *Open Markets on Bayse*\n\n${lines.join("\n\n")}\n\n_/hot for markets where signals are active_`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      return bot.sendMessage(chatId, `❌ Markets fetch failed: ${err.message}`);
    }
  });

  // ─── /hot ────────────────────────────────────────────────────────────────────
  bot.onText(/\/hot/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, `🔄 _Running signals against open markets..._`, {
      parse_mode: "Markdown",
    });

    try {
      const { findMatchingMarket, runAllSignals } = await import("../engine/scorer.js");
      const signals = await runAllSignals();
      const _pubKey = decrypt(getUser(chatId)?.bayse_pub_key);
      const match = await findMatchingMarket(signals, _pubKey);

      if (!match) {
        return bot.sendMessage(
          chatId,
          `🌡 No hot market matches right now.\n\nSignals haven't aligned with an open market. Check back soon.`
        );
      }

      return bot.sendMessage(
        chatId,
        `🔥 *Hottest Market Right Now*\n\n` +
        `*Event:* ${match.event.title}\n` +
        `*Signal:* ${match.signalSource.toUpperCase()} — \`${(match.signalScore * 100).toFixed(0)}%\`\n` +
        `*Suggested position:* ${match.suggestedOutcome}\n` +
        `*Keywords matched:* ${match.matchedKeywords.join(", ")}\n\n` +
        `_Start engine with /run to auto-trade this_`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      return bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
  });

  // ─── /limit ──────────────────────────────────────────────────────────────────
  bot.onText(/\/limit/, async (msg) => {
    const chatId = msg.chat.id;
    const user = getUser(chatId);
    updateUser(chatId, { setup_step: SETUP_STEPS.AWAITING_LIMIT_UPDATE });

    return bot.sendMessage(
      chatId,
      `💰 *Update Max Trade Amount*\n\nCurrent: \`${user?.currency || "USD"} ${user?.max_trade_usd || 5}\`\n\nSend the new maximum amount per trade (e.g. \`10\`):`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── /threshold ──────────────────────────────────────────────────────────────
  bot.onText(/\/threshold/, async (msg) => {
    const chatId = msg.chat.id;
    const user = getUser(chatId);
    updateUser(chatId, { setup_step: SETUP_STEPS.AWAITING_THRESHOLD_UPDATE });

    return bot.sendMessage(
      chatId,
      `🎯 *Update Confidence Threshold*\n\nCurrent: \`${user?.threshold || 0.72}\`\n\nSend a value between 0.5 and 0.95:`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── /disconnect ─────────────────────────────────────────────────────────────
  bot.onText(/\/disconnect/, async (msg) => {
    const chatId = msg.chat.id;
    updateUser(chatId, {
      bayse_pub_key: null,
      bayse_sec_key: null,
      engine_active: 0,
      setup_step: null,
    });

    return bot.sendMessage(
      chatId,
      `🔌 *Disconnected*\n\nYour Bayse API keys have been removed and your engine has stopped.\n\nType /connect to reconnect.`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── Text input handler — drives multi-step flows ────────────────────────────
  bot.on("message", async (msg) => {
    if (msg.text?.startsWith("/")) return; // handled by command handlers above
    const chatId = msg.chat.id;
    const text = msg.text?.trim();
    if (!text) return;

    const user = getUser(chatId);
    if (!user?.setup_step) return;

    switch (user.setup_step) {
      case SETUP_STEPS.AWAITING_PUB_KEY: {
        if (!text.startsWith("pk_")) {
          return bot.sendMessage(chatId, `❌ That doesn't look like a public key. It should start with \`pk_live_\``, {
            parse_mode: "Markdown",
          });
        }
        updateUser(chatId, {
          bayse_pub_key: encrypt(text),
          setup_step: SETUP_STEPS.AWAITING_SEC_KEY,
        });
        return bot.sendMessage(
          chatId,
          `✅ Public key saved.\n\n*Step 2/2 — Paste your Secret Key* (starts with \`sk_\`)\n\n⚠️ _This message will not be stored in chat history — send it and delete the message after._`,
          { parse_mode: "Markdown" }
        );
      }

      case SETUP_STEPS.AWAITING_SEC_KEY: {
        if (!text.startsWith("sk_")) {
          return bot.sendMessage(chatId, `❌ That doesn't look like a secret key. It should start with \`sk_\``, {
            parse_mode: "Markdown",
          });
        }

        // Validate the key pair against Bayse API
        const pubKey = decrypt(user.bayse_pub_key);
        await bot.sendMessage(chatId, `🔄 _Validating keys with Bayse..._`, {
          parse_mode: "Markdown",
        });

        const validation = await validateKeys(pubKey, text);
        if (!validation.valid) {
          return bot.sendMessage(
            chatId,
            `❌ *Key validation failed*\n\n${validation.error}\n\nDouble-check your keys and try /connect again.`,
            { parse_mode: "Markdown" }
          );
        }

        updateUser(chatId, {
          bayse_sec_key: encrypt(text),
          setup_step: null,
        });

        return bot.sendMessage(
          chatId,
          `✅ *Keys validated and saved*\n\nYour Bayse account is connected.\n\nType /setup to configure your engine, or /run to start with defaults.`,
          { parse_mode: "Markdown" }
        );
      }

      case SETUP_STEPS.AWAITING_THRESHOLD: {
        const val = parseFloat(text);
        if (isNaN(val) || val < 0.5 || val > 0.95) {
          return bot.sendMessage(chatId, `❌ Invalid value. Send a number between 0.5 and 0.95`);
        }
        updateUser(chatId, {
          threshold: val,
          setup_step: SETUP_STEPS.AWAITING_MAX_AMOUNT,
        });
        return bot.sendMessage(
          chatId,
          `✅ Threshold set to \`${val}\`\n\n*Step 2/2 — Max Trade Amount (USD)*\n\nMaximum amount per trade. Minimum recommended: \`3\`\n\nSend a number:`,
          { parse_mode: "Markdown" }
        );
      }

      case SETUP_STEPS.AWAITING_MAX_AMOUNT: {
        const val = parseFloat(text);
        if (isNaN(val) || val < 1) {
          return bot.sendMessage(chatId, `❌ Invalid amount. Must be at least 1`);
        }
        updateUser(chatId, {
          max_trade_usd: val,
          setup_step: null,
        });
        return bot.sendMessage(
          chatId,
          `✅ *Setup Complete*\n\nThreshold: \`${user.threshold}\`\nMax Trade: \`USD ${val}\`\n\nType /run to start the engine.`,
          { parse_mode: "Markdown" }
        );
      }

      case SETUP_STEPS.AWAITING_LIMIT_UPDATE: {
        const val = parseFloat(text);
        if (isNaN(val) || val < 1) {
          return bot.sendMessage(chatId, `❌ Invalid amount. Must be at least 1`);
        }
        updateUser(chatId, { max_trade_usd: val, setup_step: null });
        return bot.sendMessage(chatId, `✅ Max trade amount updated to \`USD ${val}\``, {
          parse_mode: "Markdown",
        });
      }

      case SETUP_STEPS.AWAITING_THRESHOLD_UPDATE: {
        const val = parseFloat(text);
        if (isNaN(val) || val < 0.5 || val > 0.95) {
          return bot.sendMessage(chatId, `❌ Send a number between 0.5 and 0.95`);
        }
        updateUser(chatId, { threshold: val, setup_step: null });
        return bot.sendMessage(chatId, `✅ Confidence threshold updated to \`${val}\``, {
          parse_mode: "Markdown",
        });
      }
    }
  });

  // ─── Group events ────────────────────────────────────────────────────────────
  bot.on("new_chat_members", (msg) => {
    const isBot = msg.new_chat_members?.some((m) => m.is_bot && m.username === bot.options?.username);
    if (isBot) {
      upsertGroup(msg.chat.id, msg.chat.title, msg.from?.id);
      bot.sendMessage(
        msg.chat.id,
        `📡 *Harbinger joined the group*\n\nI'll broadcast live signal updates here whenever markets get hot.\n\n_Each member can run their own trading engine via DM._`,
        { parse_mode: "Markdown" }
      );
    }
  });

  bot.on("left_chat_member", (msg) => {
    const isBot = msg.left_chat_member?.is_bot;
    if (isBot) removeGroup(msg.chat.id);
  });
}

// ─── Manual trading commands ──────────────────────────────────────────────────
// Registered separately — call this from server.js after registerCommands()

export function registerTradeCommands(bot) {
  const TRADE_STEPS = {
    AWAITING_MARKET_SEARCH: "trade_awaiting_search",
    AWAITING_OUTCOME:       "trade_awaiting_outcome",
    AWAITING_AMOUNT:        "trade_awaiting_amount",
    AWAITING_CONFIRM:       "trade_awaiting_confirm",
  };

  // Store pending trade state per user in memory (cleared on confirm/cancel)
  const pendingTrades = new Map();

  // ── /trade — entry point ───────────────────────────────────────────────────
  bot.onText(/\/trade/, async (msg) => {
    const chatId = msg.chat.id;
    const user   = getUser(chatId);

    if (!user?.bayse_pub_key || !user?.bayse_sec_key) {
      return bot.sendMessage(chatId, `❌ Connect your Bayse keys first with /connect`);
    }

    updateUser(chatId, { setup_step: TRADE_STEPS.AWAITING_MARKET_SEARCH });

    return bot.sendMessage(
      chatId,
      `🔎 *Manual Trade*\n\nSearch for a market to trade on.\n\nSend a keyword — e.g. \`bitcoin\`, \`nigeria\`, \`chelsea\`, \`election\``,
      { parse_mode: "Markdown" }
    );
  });

  // ── /cancel — abort any pending trade ─────────────────────────────────────
  bot.onText(/\/cancel/, async (msg) => {
    const chatId = msg.chat.id;
    pendingTrades.delete(chatId);
    updateUser(chatId, { setup_step: null });
    return bot.sendMessage(chatId, `❌ Trade cancelled.`);
  });

  // ── Text handler — drives trade flow steps ────────────────────────────────
  bot.on("message", async (msg) => {
    if (msg.text?.startsWith("/")) return;
    const chatId = msg.chat.id;
    const text   = msg.text?.trim();
    if (!text) return;

    const user = getUser(chatId);
    if (!user?.setup_step?.startsWith("trade_")) return;

    switch (user.setup_step) {

      // Step 1 — search markets by keyword
      case TRADE_STEPS.AWAITING_MARKET_SEARCH: {
        await bot.sendMessage(chatId, `🔄 _Searching markets for "${text}"..._`, { parse_mode: "Markdown" });

        try {
          const { getEvents: _getEvt } = await import("../bayse/client.js");
          const _userPub = decrypt(user.bayse_pub_key);
          const events = await _getEvt(_userPub, { status: "open", size: 50, keyword: text.toLowerCase() });

          const keyword = text.toLowerCase();
          const matches = events.filter((e) => {
            const t = (e.title || "").toLowerCase();
            const d = (e.description || "").toLowerCase();
            return t.includes(keyword) || d.includes(keyword);
          }).slice(0, 6);

          if (!matches.length) {
            return bot.sendMessage(
              chatId,
              `📭 No markets found for "*${text}*"\n\nTry a different keyword, or /markets to see all open markets.`,
              { parse_mode: "Markdown" }
            );
          }

          // Store results and show numbered list
          pendingTrades.set(chatId, { searchResults: matches });
          updateUser(chatId, { setup_step: TRADE_STEPS.AWAITING_OUTCOME });

          const lines = matches.map((e, i) => {
            const engine = e.engine ? ` \\[${e.engine}\\]` : "";
            return `*${i + 1}.* ${e.title}${engine}`;
          });

          return bot.sendMessage(
            chatId,
            `📋 *Markets found:*\n\n${lines.join("\n\n")}\n\nReply with the *number* of the market you want to trade, then your position:\ne.g. \`1 YES\` or \`2 NO\`\n\n_/cancel to abort_`,
            { parse_mode: "Markdown" }
          );
        } catch (err) {
          updateUser(chatId, { setup_step: null });
          return bot.sendMessage(chatId, `❌ Search failed: ${err.message}`);
        }
      }

      // Step 2 — pick market number + outcome
      case TRADE_STEPS.AWAITING_OUTCOME: {
        const parts   = text.toUpperCase().split(/\s+/);
        const num     = parseInt(parts[0]);
        const outcome = parts[1]; // YES or NO

        const pending = pendingTrades.get(chatId);
        if (!pending?.searchResults) {
          updateUser(chatId, { setup_step: null });
          return bot.sendMessage(chatId, `❌ Session expired. Start again with /trade`);
        }

        if (isNaN(num) || num < 1 || num > pending.searchResults.length) {
          return bot.sendMessage(chatId, `❌ Send a number between 1 and ${pending.searchResults.length}, then YES or NO\ne.g. \`1 YES\``);
        }

        if (!outcome || !["YES", "NO"].includes(outcome)) {
          return bot.sendMessage(chatId, `❌ Include YES or NO after the number\ne.g. \`${num} YES\``);
        }

        const selectedEvent = pending.searchResults[num - 1];
        const market = selectedEvent.markets?.find((m) => m.status === "open");

        if (!market) {
          return bot.sendMessage(chatId, `❌ No open market found for that event. Try another.`);
        }

        pendingTrades.set(chatId, {
          ...pending,
          event: selectedEvent,
          market,
          outcome,
        });

        updateUser(chatId, { setup_step: TRADE_STEPS.AWAITING_AMOUNT });

        return bot.sendMessage(
          chatId,
          `✅ *${selectedEvent.title}*\nPosition: *${outcome}*\n\nHow much do you want to trade? (${user.currency || "USD"})\nMin: 1 | Your max: ${user.max_trade_usd || 5}\n\n_/cancel to abort_`,
          { parse_mode: "Markdown" }
        );
      }

      // Step 3 — get amount, show quote
      case TRADE_STEPS.AWAITING_AMOUNT: {
        const amount = parseFloat(text);
        if (isNaN(amount) || amount < 1) {
          return bot.sendMessage(chatId, `❌ Enter a valid amount (minimum 1)`);
        }

        const pending = pendingTrades.get(chatId);
        if (!pending?.event) {
          updateUser(chatId, { setup_step: null });
          return bot.sendMessage(chatId, `❌ Session expired. Start again with /trade`);
        }

        await bot.sendMessage(chatId, `🔄 _Getting quote..._`, { parse_mode: "Markdown" });

        try {
          const { getQuote, resolveOutcomeId } = await import("../bayse/client.js");
          const { decrypt }  = await import("../utils/encryption.js");

          const pubKey = decrypt(user.bayse_pub_key);
          const currency = user.currency || "USD";
          const outcomeId = resolveOutcomeId(pending.market, pending.outcome);

          const quote = await getQuote(pubKey, pending.event.id, pending.market.id, outcomeId, "BUY", amount, currency);

          pendingTrades.set(chatId, { ...pending, amount, quote });
          updateUser(chatId, { setup_step: TRADE_STEPS.AWAITING_CONFIRM });

          return bot.sendMessage(
            chatId,
            `📊 *Trade Quote*\n\n` +
            `Event: *${pending.event.title}*\n` +
            `Position: *BUY ${pending.outcome}*\n` +
            `Amount: *${currency} ${amount}*\n\n` +
            `Entry price: \`${(quote.price * 100).toFixed(1)}¢\`\n` +
            `Shares: \`${quote.quantity?.toFixed(2) || "—"}\`\n` +
            `Fee: \`${quote.fee?.toFixed(2) || "0"}\`\n` +
            `Total cost: \`${currency} ${quote.amount?.toFixed(2) || amount}\`\n\n` +
            `Reply *CONFIRM* to place this trade or /cancel to abort.`,
            { parse_mode: "Markdown" }
          );
        } catch (err) {
          updateUser(chatId, { setup_step: null });
          pendingTrades.delete(chatId);
          return bot.sendMessage(chatId, `❌ Quote failed: ${err.message}`);
        }
      }

      // Step 4 — confirm and execute
      case TRADE_STEPS.AWAITING_CONFIRM: {
        if (text.toUpperCase() !== "CONFIRM") {
          return bot.sendMessage(chatId, `Reply *CONFIRM* to place the trade or /cancel to abort.`, { parse_mode: "Markdown" });
        }

        const pending = pendingTrades.get(chatId);
        if (!pending?.event) {
          updateUser(chatId, { setup_step: null });
          return bot.sendMessage(chatId, `❌ Session expired. Start again with /trade`);
        }

        await bot.sendMessage(chatId, `⚡ _Placing trade..._`, { parse_mode: "Markdown" });

        try {
          const { placeOrder, resolveOutcomeId: _resolve } = await import("../bayse/client.js");
          const { decrypt }     = await import("../utils/encryption.js");
          const { insertTrade } = await import("../db/database.js");

          const pubKey   = decrypt(user.bayse_pub_key);
          const secKey   = decrypt(user.bayse_sec_key);
          const currency = user.currency || "USD";
          const _outcomeId = _resolve(pending.market, pending.outcome);

          const order = await placeOrder(pubKey, secKey, pending.event.id, pending.market.id, {
            side: "BUY",
            outcomeId: _outcomeId,
            amount: pending.amount,
            currency,
          });

          insertTrade({
            chat_id:       String(chatId),
            event_id:      pending.event.id,
            market_id:     pending.market.id,
            event_title:   pending.event.title,
            signal_source: "manual",
            confidence:    1.0,
            side:          "BUY",
            outcome:       pending.outcome,
            amount:        pending.amount,
            currency,
            expected_price: pending.quote?.price || null,
            status:        "open",
          });

          pendingTrades.delete(chatId);
          updateUser(chatId, { setup_step: null });

          return bot.sendMessage(
            chatId,
            `✅ *Trade Placed*\n\n` +
            `*${pending.event.title}*\n` +
            `BUY ${pending.outcome} | ${currency} ${pending.amount}\n` +
            `Entry: \`${(pending.quote?.price * 100).toFixed(1)}¢\`\n\n` +
            `_Track it with /trades_`,
            { parse_mode: "Markdown" }
          );
        } catch (err) {
          pendingTrades.delete(chatId);
          updateUser(chatId, { setup_step: null });
          return bot.sendMessage(chatId, `❌ Trade failed: ${err.message}`);
        }
      }
    }
  });
}
