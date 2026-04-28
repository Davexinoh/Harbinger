import {
  upsertUser, getUser, updateUser, upsertGroup, removeGroup,
  getRecentTrades, getPnL, getLeaderboard,
} from "../db/database.js";
import { encrypt, decrypt } from "../utils/encryption.js";
import { validateKeys, getEvents } from "../bayse/client.js";
import { runAllSignals } from "../engine/scorer.js";
import { getEngineStatus } from "../engine/engineLoop.js";

const SETUP_STEPS = {
  AWAITING_PUB_KEY:           "awaiting_pub_key",
  AWAITING_SEC_KEY:           "awaiting_sec_key",
  AWAITING_THRESHOLD:         "awaiting_threshold",
  AWAITING_MAX_AMOUNT:        "awaiting_max_amount",
  AWAITING_CURRENCY:          "awaiting_currency",
  AWAITING_LIMIT_UPDATE:      "awaiting_limit_update",
  AWAITING_THRESHOLD_UPDATE:  "awaiting_threshold_update",
  AWAITING_CATEGORY:          "awaiting_category",
};

const VALID_CATEGORIES = ["sports", "crypto", "politics", "entertainment", "finance", "all"];

function signalBar(score) {
  const filled = Math.round(score * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled) + ` ${(score * 100).toFixed(0)}%`;
}

export function registerCommands(bot) {

  // ─── /start ─────────────────────────────────────────────────────────────────
  bot.onText(/\/start/, async (msg) => {
    const chatId  = msg.chat.id;
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";

    if (isGroup) {
      upsertGroup(chatId, msg.chat.title, msg.from?.id);
      return bot.sendMessage(
        chatId,
        `📡 *Harbinger is now active in this group*\n\nI'll broadcast live signal updates and crowd polls whenever markets heat up.\n\n_Start your personal engine → message me directly_`,
        { parse_mode: "Markdown" }
      );
    }

    upsertUser(chatId, msg.from?.username);
    const user    = getUser(chatId);
    const hasKeys = user?.bayse_pub_key && user?.bayse_sec_key;

    return bot.sendMessage(
      chatId,
      `🔮 *Harbinger*\n` +
      `_The market moves. We saw it coming._\n\n` +
      `Three signals. One engine. Fully autonomous.\n\n` +
      `Harbinger watches crypto momentum, football form, and live news — then trades Bayse prediction markets the moment signals converge. No charts. No clicking. Just results.\n\n` +
      (hasKeys
        ? `Keys connected. Pick up where you left off:\n/run — fire the engine\n/signals — live signal scores right now\n/trades — your trade history\n\n`
        : `Get started:\n/connect — link your Bayse account\n/setup — set threshold and trade size\n/run — engine takes over\n\n`) +
      `/trade — place a manual trade\n` +
      `/markets — browse open markets\n` +
      `/hot — markets with active signals\n` +
      `/category — set preferred market type\n` +
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
      `🔑 *Connect Your Bayse Account*\n\nGet your API keys from Bayse:\n1. Log in at bayse.markets\n2. Settings → API Keys\n3. Create a new key pair\n\n*Step 1/2 — Paste your Public Key* (starts with \`pk_live_\`)\n\n⚠️ _Keys are encrypted and stored only on this server._`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── /setup ──────────────────────────────────────────────────────────────────
  bot.onText(/\/setup/, async (msg) => {
    const chatId = msg.chat.id;
    const user   = getUser(chatId);

    if (!user?.bayse_pub_key) {
      return bot.sendMessage(chatId, `❌ Connect your Bayse keys first with /connect`);
    }

    updateUser(chatId, { setup_step: SETUP_STEPS.AWAITING_THRESHOLD });

    return bot.sendMessage(
      chatId,
      `⚙️ *Engine Setup*\n\n*Step 1/3 — Confidence Threshold*\n\nHow confident the engine needs to be before trading.\n\n\`0.55\` — aggressive, trades often\n\`0.60\` — balanced (recommended)\n\`0.75\` — conservative, trades rarely\n\nCurrent: \`${user.threshold || 0.60}\`\n\nSend a number between 0.5 and 0.95, or reply \`default\` to use 0.60:`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── /category ───────────────────────────────────────────────────────────────
  bot.onText(/\/category/, async (msg) => {
    const chatId  = msg.chat.id;
    const user    = getUser(chatId);
    const current = user?.preferred_category || "all";

    updateUser(chatId, { setup_step: SETUP_STEPS.AWAITING_CATEGORY });

    return bot.sendMessage(
      chatId,
      `🎯 *Market Category*\n\nCurrent: \`${current}\`\n\nTell the engine which markets to focus on.\n\n\`sports\` — football, basketball, tennis\n\`crypto\` — BTC, ETH, crypto markets\n\`politics\` — elections, government\n\`entertainment\` — celebrities, music\n\`finance\` — forex, stocks, economy\n\`all\` — engine decides (default)\n\nReply with your choice:`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── /run ────────────────────────────────────────────────────────────────────
  bot.onText(/\/run/, async (msg) => {
    const chatId = msg.chat.id;
    const user   = getUser(chatId);

    if (!user?.bayse_pub_key || !user?.bayse_sec_key) {
      return bot.sendMessage(chatId, `❌ Connect your Bayse keys first with /connect`);
    }

    updateUser(chatId, { engine_active: 1 });

    const category = user.preferred_category || "all";

    return bot.sendMessage(
      chatId,
      `🟢 *Engine Started*\n\nHarbinger is running for your account.\n\n📊 Signals evaluated every minute\n🎯 Threshold: \`${user.threshold || 0.60}\`\n💰 Max trade: \`${user.currency || "USD"} ${user.max_trade_usd || 5}\`\n🏷 Category: \`${category}\`\n\nI'll message you the moment I fire a trade.\n\n_/pause to stop | /status to check in_`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── /pause ──────────────────────────────────────────────────────────────────
  bot.onText(/\/pause/, async (msg) => {
    updateUser(msg.chat.id, { engine_active: 0 });
    return bot.sendMessage(msg.chat.id, `⏸ *Engine Paused*\n\nNo trades will fire. Type /resume to restart.`, { parse_mode: "Markdown" });
  });

  // ─── /resume ─────────────────────────────────────────────────────────────────
  bot.onText(/\/resume/, async (msg) => {
    const chatId = msg.chat.id;
    const user   = getUser(chatId);
    if (!user?.bayse_pub_key) {
      return bot.sendMessage(chatId, `❌ Connect your keys first with /connect`);
    }
    updateUser(chatId, { engine_active: 1 });
    return bot.sendMessage(chatId, `▶️ *Engine Resumed*\n\nBack to watching signals.`, { parse_mode: "Markdown" });
  });

  // ─── /stop ───────────────────────────────────────────────────────────────────
  bot.onText(/\/stop/, async (msg) => {
    updateUser(msg.chat.id, { engine_active: 0 });
    return bot.sendMessage(msg.chat.id, `🔴 *Engine Stopped*\n\nHarbinger is no longer trading for your account.\n\n_/run to restart_`, { parse_mode: "Markdown" });
  });

  // ─── /status ─────────────────────────────────────────────────────────────────
  bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const user   = getUser(chatId);
    const engine = getEngineStatus();
    const hasKeys = user?.bayse_pub_key && user?.bayse_sec_key;
    const state   = user?.engine_active ? "🟢 Running" : "🔴 Paused";
    const category = user?.preferred_category || "all";

    return bot.sendMessage(
      chatId,
      `📊 *Harbinger Status*\n\n` +
      `Engine: ${state}\n` +
      `Keys: ${hasKeys ? "✅ Connected" : "❌ Not connected"}\n` +
      `Threshold: \`${user?.threshold || 0.60}\`\n` +
      `Max Trade: \`${user?.currency || "USD"} ${user?.max_trade_usd || 5}\`\n` +
      `Category: \`${category}\`\n\n` +
      `*Global Engine*\n` +
      `Active users: ${engine.activeUsers}\n` +
      `Tick interval: ${engine.tickIntervalMs / 1000}s\n\n` +
      `_/signals for live scores_`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── /signals ────────────────────────────────────────────────────────────────
  bot.onText(/\/signals/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, `🔄 _Fetching live signals..._`, { parse_mode: "Markdown" });

    try {
      const signals = await runAllSignals();
      const { crypto, sports, sentiment, composite } = signals;
      const status = composite >= 0.65 ? "🔥 THRESHOLD BREACH" : composite >= 0.55 ? "⚡ WARMING UP" : "📡 MONITORING";

      return bot.sendMessage(
        chatId,
        `📡 *Live Signal Report*\n\n` +
        `*Crypto* ${crypto.direction === "UP" ? "🟢" : crypto.direction === "DOWN" ? "🔴" : "⚪"}\n` +
        `${signalBar(crypto.score)}\n` +
        `${crypto.best ? `${crypto.best.symbol} ${crypto.best.change1h}% (1h) | ${crypto.best.change24h}% (24h)` : crypto.error || "No data"}\n\n` +
        `*Sports* ${sports.direction === "YES" ? "🟢" : sports.direction === "NO" ? "🔴" : "⚪"}\n` +
        `${signalBar(sports.score)}\n` +
        `${sports.best ? sports.best.title?.slice(0, 60) || "Active market" : sports.reason || "No sports markets"}\n\n` +
        `*Sentiment* ${sentiment.direction === "bullish" ? "🟢" : sentiment.direction === "bearish" ? "🔴" : "⚪"}\n` +
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
      return bot.sendMessage(chatId, `📋 *No trades yet*\n\nStart the engine with /run to begin trading.`, { parse_mode: "Markdown" });
    }

    const lines = trades.map((t, i) => {
      const status = t.status === "resolved" ? (t.pnl > 0 ? "✅" : "❌") : "⏳";
      const pnl    = t.pnl != null ? ` | P&L: ${t.pnl > 0 ? "+" : ""}${t.pnl?.toFixed(2)}` : "";
      return `${i + 1}. ${status} *${t.event_title.slice(0, 35)}*\n   ${t.side} ${t.outcome} | ${t.currency} ${t.amount} | ${t.signal_source}${pnl}`;
    });

    return bot.sendMessage(chatId, `📋 *Recent Trades*\n\n${lines.join("\n\n")}`, { parse_mode: "Markdown" });
  });

  // ─── /pnl ────────────────────────────────────────────────────────────────────
  bot.onText(/\/pnl/, async (msg) => {
    const chatId = msg.chat.id;
    const stats  = getPnL(chatId);

    if (!stats || stats.total_trades === 0) {
      return bot.sendMessage(chatId, `📈 *No resolved trades yet*\n\nP&L tracks once markets resolve.`, { parse_mode: "Markdown" });
    }

    const winRate  = stats.total_trades > 0 ? (stats.wins / stats.total_trades) * 100 : 0;
    const pnlEmoji = stats.total_pnl >= 0 ? "🟢" : "🔴";

    return bot.sendMessage(
      chatId,
      `📈 *Your P&L Summary*\n\n` +
      `Total Trades: \`${stats.total_trades}\`\n` +
      `Wins / Losses: \`${stats.wins} / ${stats.losses}\`\n` +
      `Win Rate: \`${winRate.toFixed(1)}%\`\n` +
      `Total P&L: ${pnlEmoji} \`${stats.total_pnl >= 0 ? "+" : ""}${stats.total_pnl.toFixed(2)}\`\n` +
      `Avg Confidence: \`${(stats.avg_confidence * 100).toFixed(0)}%\`\n\n` +
      `_/trades for full history_`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── /markets ────────────────────────────────────────────────────────────────
  bot.onText(/\/markets/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, `🔄 _Fetching open markets..._`, { parse_mode: "Markdown" });

    try {
      const user   = getUser(chatId);
      const pubKey = decrypt(user?.bayse_pub_key);
      if (!pubKey) return bot.sendMessage(chatId, `❌ Connect your Bayse keys first with /connect`);

      const category = user?.preferred_category || null;
      const events   = await getEvents(pubKey, { status: "open", size: 10, category });

      if (!events.length) return bot.sendMessage(chatId, `📭 No open markets found right now.`);

      const lines = events.slice(0, 8).map((e, i) => {
        const engine  = e.engine ? ` [${e.engine}]` : "";
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
    await bot.sendMessage(chatId, `🔄 _Running signals against open markets..._`, { parse_mode: "Markdown" });

    try {
      const { findMatchingMarket } = await import("../engine/scorer.js");
      const user    = getUser(chatId);
      const pubKey  = decrypt(user?.bayse_pub_key);
      const signals = await runAllSignals();
      const match   = await findMatchingMarket(signals, pubKey, null, user?.preferred_category);

      if (!match) {
        return bot.sendMessage(chatId, `🌡 No hot market matches right now.\n\nCheck back soon.`);
      }

      return bot.sendMessage(
        chatId,
        `🔥 *Hottest Market Right Now*\n\n` +
        `*Event:* ${match.event.title}\n` +
        `*Signal:* ${match.signalSource.toUpperCase()} — \`${(match.signalScore * 100).toFixed(0)}%\`\n` +
        `*Suggested position:* ${match.suggestedOutcome}\n` +
        `*Keywords matched:* ${match.matchedKeywords.slice(0, 3).join(", ")}\n\n` +
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
    const user   = getUser(chatId);
    updateUser(chatId, { setup_step: SETUP_STEPS.AWAITING_LIMIT_UPDATE });
    return bot.sendMessage(
      chatId,
      `💰 *Update Max Trade Amount*\n\nCurrent: \`${user?.currency || "USD"} ${user?.max_trade_usd || 5}\`\n\nSend the new maximum amount per trade:`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── /threshold ──────────────────────────────────────────────────────────────
  bot.onText(/\/threshold/, async (msg) => {
    const chatId = msg.chat.id;
    const user   = getUser(chatId);
    updateUser(chatId, { setup_step: SETUP_STEPS.AWAITING_THRESHOLD_UPDATE });
    return bot.sendMessage(
      chatId,
      `🎯 *Update Confidence Threshold*\n\nCurrent: \`${user?.threshold || 0.60}\`\n\nSend a value between 0.5 and 0.95:`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── /leaderboard ────────────────────────────────────────────────────────────
  bot.onText(/\/leaderboard/, async (msg) => {
    const chatId = msg.chat.id;
    const board  = getLeaderboard(10);

    if (!board.length) {
      return bot.sendMessage(chatId, `🏆 *Leaderboard*\n\nNo resolved trades yet. Check back once markets settle.`, { parse_mode: "Markdown" });
    }

    const medals = ["🥇", "🥈", "🥉"];
    const lines  = board.map((u, i) => {
      const medal    = medals[i] || `${i + 1}.`;
      const username = u.username ? `@${u.username}` : `User ${String(u.chat_id).slice(-4)}`;
      return `${medal} ${username}\n   Win rate: \`${u.win_rate}%\` | Trades: \`${u.total_trades}\` | P&L: \`${u.total_pnl >= 0 ? "+" : ""}${u.total_pnl.toFixed(2)}\``;
    });

    return bot.sendMessage(
      chatId,
      `🏆 *Harbinger Leaderboard*\n\n${lines.join("\n\n")}\n\n_Rankings by win rate. Min 3 resolved trades to qualify._`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── /crowdiq ────────────────────────────────────────────────────────────────
  bot.onText(/\/crowdiq/, async (msg) => {
    const chatId = msg.chat.id;
    const { getCrowdIQReport, getRecentPolls } = await import("../signals/crowdSignal.js");
    const stats  = getCrowdIQReport();
    const recent = getRecentPolls(5);

    if (!stats || stats.total_polls === 0) {
      return bot.sendMessage(
        chatId,
        `🧠 *Crowd IQ*\n\nNo resolved polls yet.\n\nCrowd wisdom polls fire automatically when signals heat up. Add Harbinger to a group to start collecting votes.`,
        { parse_mode: "Markdown" }
      );
    }

    const iqRating =
      stats.accuracy_pct >= 70 ? "🔥 Sharp"
      : stats.accuracy_pct >= 55 ? "✅ Above Average"
      : stats.accuracy_pct >= 45 ? "⚪ Average"
      : "⚠️ Below Average";

    const recentLines = recent
      .filter(p => p.resolved)
      .slice(0, 3)
      .map(p => {
        const result = p.crowd_was_right ? "✅" : "❌";
        const votes  = p.votes_yes + p.votes_no + p.votes_unsure;
        return `${result} "${p.event_title.slice(0, 40)}" — ${votes} votes`;
      }).join("\n");

    return bot.sendMessage(
      chatId,
      `🧠 *Harbinger Crowd IQ*\n\n` +
      `Rating: *${iqRating}*\n` +
      `Accuracy: \`${stats.accuracy_pct}%\` (${stats.correct}/${stats.total_polls} correct)\n` +
      `Avg votes/poll: \`${Math.round(stats.avg_votes_per_poll || 0)}\`\n` +
      `Active polls: \`${stats.active_polls}\`\n\n` +
      (recentLines ? `*Recent Polls*\n${recentLines}\n\n` : "") +
      `_Crowd signal is live — your votes feed directly into the engine._`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── /disconnect ─────────────────────────────────────────────────────────────
  bot.onText(/\/disconnect/, async (msg) => {
    const chatId = msg.chat.id;
    updateUser(chatId, { bayse_pub_key: null, bayse_sec_key: null, engine_active: 0, setup_step: null });
    return bot.sendMessage(
      chatId,
      `🔌 *Disconnected*\n\nYour Bayse API keys have been removed and your engine has stopped.\n\nType /connect to reconnect.`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── Text input handler — drives all multi-step flows ────────────────────────
  bot.on("message", async (msg) => {
    if (msg.text?.startsWith("/")) return;
    const chatId = msg.chat.id;
    const text   = msg.text?.trim();
    if (!text) return;

    const user = getUser(chatId);
    if (!user?.setup_step) return;

    switch (user.setup_step) {

      case SETUP_STEPS.AWAITING_PUB_KEY: {
        if (!text.startsWith("pk_")) {
          return bot.sendMessage(chatId, `❌ That doesn't look like a public key. It should start with \`pk_live_\``, { parse_mode: "Markdown" });
        }
        updateUser(chatId, { bayse_pub_key: encrypt(text), setup_step: SETUP_STEPS.AWAITING_SEC_KEY });
        return bot.sendMessage(
          chatId,
          `✅ Public key saved.\n\n*Step 2/2 — Paste your Secret Key* (starts with \`sk_\`)\n\n⚠️ _Send it then delete the message._`,
          { parse_mode: "Markdown" }
        );
      }

      case SETUP_STEPS.AWAITING_SEC_KEY: {
        if (!text.startsWith("sk_")) {
          return bot.sendMessage(chatId, `❌ That doesn't look like a secret key. Should start with \`sk_\``, { parse_mode: "Markdown" });
        }
        await bot.sendMessage(chatId, `🔄 _Validating keys with Bayse..._`, { parse_mode: "Markdown" });
        const pubKey     = decrypt(user.bayse_pub_key);
        const validation = await validateKeys(pubKey, text);
        if (!validation.valid) {
          return bot.sendMessage(chatId, `❌ *Key validation failed*\n\n${validation.error}\n\nDouble-check and try /connect again.`, { parse_mode: "Markdown" });
        }
        updateUser(chatId, { bayse_sec_key: encrypt(text), setup_step: null });
        return bot.sendMessage(chatId, `✅ *Keys validated and saved*\n\nType /setup to configure your engine, or /run to start with defaults.`, { parse_mode: "Markdown" });
      }

      case SETUP_STEPS.AWAITING_THRESHOLD: {
        if (text.toLowerCase() === "default") {
          updateUser(chatId, { threshold: 0.60, setup_step: SETUP_STEPS.AWAITING_MAX_AMOUNT });
          return bot.sendMessage(chatId, `✅ Threshold set to \`0.60\`\n\n*Step 2/3 — Max Trade Amount*\n\nSend a number (minimum 1):`, { parse_mode: "Markdown" });
        }
        const val = parseFloat(text);
        if (isNaN(val) || val < 0.5 || val > 0.95) {
          return bot.sendMessage(chatId, `❌ Send a number between 0.5 and 0.95, or reply \`default\``);
        }
        updateUser(chatId, { threshold: val, setup_step: SETUP_STEPS.AWAITING_MAX_AMOUNT });
        return bot.sendMessage(chatId, `✅ Threshold set to \`${val}\`\n\n*Step 2/3 — Max Trade Amount*\n\nSend a number:`, { parse_mode: "Markdown" });
      }

      case SETUP_STEPS.AWAITING_MAX_AMOUNT: {
        const val = parseFloat(text);
        if (isNaN(val) || val < 1) {
          return bot.sendMessage(chatId, `❌ Invalid amount. Must be at least 1`);
        }
        updateUser(chatId, { max_trade_usd: val, setup_step: SETUP_STEPS.AWAITING_CURRENCY });
        return bot.sendMessage(chatId, `✅ Max trade set to \`${val}\`\n\n*Step 3/3 — Currency*\n\nReply \`USD\` or \`NGN\`:`, { parse_mode: "Markdown" });
      }

      case SETUP_STEPS.AWAITING_CURRENCY: {
        const val = text.toUpperCase().trim();
        if (!["USD", "NGN"].includes(val)) {
          return bot.sendMessage(chatId, `❌ Reply \`USD\` or \`NGN\``);
        }
        updateUser(chatId, { currency: val, setup_step: null });
        return bot.sendMessage(
          chatId,
          `✅ *Setup Complete*\n\nThreshold: \`${user.threshold || 0.60}\`\nMax Trade: \`${val} ${user.max_trade_usd}\`\nCurrency: \`${val}\`\n\nType /run to start the engine.`,
          { parse_mode: "Markdown" }
        );
      }

      case SETUP_STEPS.AWAITING_LIMIT_UPDATE: {
        const val = parseFloat(text);
        if (isNaN(val) || val < 1) return bot.sendMessage(chatId, `❌ Must be at least 1`);
        updateUser(chatId, { max_trade_usd: val, setup_step: null });
        return bot.sendMessage(chatId, `✅ Max trade updated to \`${user.currency || "USD"} ${val}\``, { parse_mode: "Markdown" });
      }

      case SETUP_STEPS.AWAITING_THRESHOLD_UPDATE: {
        const val = parseFloat(text);
        if (isNaN(val) || val < 0.5 || val > 0.95) return bot.sendMessage(chatId, `❌ Send a number between 0.5 and 0.95`);
        updateUser(chatId, { threshold: val, setup_step: null });
        return bot.sendMessage(chatId, `✅ Threshold updated to \`${val}\``, { parse_mode: "Markdown" });
      }

      case SETUP_STEPS.AWAITING_CATEGORY: {
        const val = text.toLowerCase().trim();
        if (!VALID_CATEGORIES.includes(val)) {
          return bot.sendMessage(chatId, `❌ Send one of: ${VALID_CATEGORIES.join(", ")}`);
        }
        updateUser(chatId, { preferred_category: val === "all" ? null : val, setup_step: null });
        return bot.sendMessage(
          chatId,
          `✅ Engine will now focus on *${val}* markets.\n\n_/run to start trading_`,
          { parse_mode: "Markdown" }
        );
      }
    }
  });

  // ─── Group events ─────────────────────────────────────────────────────────────
  bot.on("new_chat_members", (msg) => {
    const isBot = msg.new_chat_members?.some(m => m.is_bot);
    if (isBot) {
      upsertGroup(msg.chat.id, msg.chat.title, msg.from?.id);
      bot.sendMessage(
        msg.chat.id,
        `📡 *Harbinger joined the group*\n\nI'll broadcast crowd polls and signal updates whenever markets heat up.\n\n_Each member runs their own trading engine via DM._`,
        { parse_mode: "Markdown" }
      );
    }
  });

  bot.on("left_chat_member", (msg) => {
    if (msg.left_chat_member?.is_bot) removeGroup(msg.chat.id);
  });
}

// ─── Manual trading commands ──────────────────────────────────────────────────
export function registerTradeCommands(bot) {
  const TRADE_STEPS = {
    AWAITING_MARKET_SEARCH: "trade_awaiting_search",
    AWAITING_OUTCOME:       "trade_awaiting_outcome",
    AWAITING_AMOUNT:        "trade_awaiting_amount",
    AWAITING_CONFIRM:       "trade_awaiting_confirm",
  };

  const pendingTrades = new Map();

  bot.onText(/\/trade/, async (msg) => {
    const chatId = msg.chat.id;
    const user   = getUser(chatId);
    if (!user?.bayse_pub_key || !user?.bayse_sec_key) {
      return bot.sendMessage(chatId, `❌ Connect your Bayse keys first with /connect`);
    }
    updateUser(chatId, { setup_step: TRADE_STEPS.AWAITING_MARKET_SEARCH });
    return bot.sendMessage(
      chatId,
      `🔎 *Manual Trade*\n\nSearch for a market.\n\nSend a keyword — e.g. \`bitcoin\`, \`nigeria\`, \`arsenal\`, \`election\``,
      { parse_mode: "Markdown" }
    );
  });

  bot.onText(/\/cancel/, async (msg) => {
    const chatId = msg.chat.id;
    pendingTrades.delete(chatId);
    updateUser(chatId, { setup_step: null });
    return bot.sendMessage(chatId, `❌ Trade cancelled.`);
  });

  bot.on("message", async (msg) => {
    if (msg.text?.startsWith("/")) return;
    const chatId = msg.chat.id;
    const text   = msg.text?.trim();
    if (!text) return;

    const user = getUser(chatId);
    if (!user?.setup_step?.startsWith("trade_")) return;

    switch (user.setup_step) {

      case TRADE_STEPS.AWAITING_MARKET_SEARCH: {
        await bot.sendMessage(chatId, `🔄 _Searching markets for "${text}"..._`, { parse_mode: "Markdown" });
        try {
          const { getEvents: _getEvt } = await import("../bayse/client.js");
          const _userPub = decrypt(user.bayse_pub_key);
          const events   = await _getEvt(_userPub, { status: "open", size: 50, keyword: text.toLowerCase() });

          if (!events.length) {
            return bot.sendMessage(chatId, `📭 No markets found for "*${text}*"\n\nTry a different keyword, or /markets to see all open markets.`, { parse_mode: "Markdown" });
          }

          const matches = events.slice(0, 6);
          pendingTrades.set(chatId, { searchResults: matches });
          updateUser(chatId, { setup_step: TRADE_STEPS.AWAITING_OUTCOME });

          const lines = matches.map((e, i) => {
            const openMarkets = (e.markets || []).filter(m => m.status === "open").length;
            return `*${i + 1}.* ${e.title} — ${openMarkets} market(s)`;
          });

          return bot.sendMessage(
            chatId,
            `📋 *Events found:*\n\n${lines.join("\n\n")}\n\nReply with the *number* of the event.\n\n_/cancel to abort_`,
            { parse_mode: "Markdown" }
          );
        } catch (err) {
          updateUser(chatId, { setup_step: null });
          return bot.sendMessage(chatId, `❌ Search failed: ${err.message}`);
        }
      }

      case TRADE_STEPS.AWAITING_OUTCOME: {
        const pending = pendingTrades.get(chatId);

        if (pending?.searchResults && !pending?.event) {
          const num = parseInt(text);
          if (isNaN(num) || num < 1 || num > pending.searchResults.length) {
            return bot.sendMessage(chatId, `❌ Send a number between 1 and ${pending.searchResults.length}`);
          }
          const selectedEvent = pending.searchResults[num - 1];
          const openMarkets   = (selectedEvent.markets || []).filter(m => m.status === "open");
          if (!openMarkets.length) return bot.sendMessage(chatId, `❌ No open markets on that event.`);

          const currency    = user.currency || "USD";
          const marketLines = openMarkets.map((m, i) => {
            const yesPrice = m.outcome1Price ? `${(m.outcome1Price * 100).toFixed(0)}¢` : "—";
            const noPrice  = m.outcome2Price ? `${(m.outcome2Price * 100).toFixed(0)}¢` : "—";
            const label    = m.title || m.outcome1Label || "Market";
            return `*${i + 1}.* ${label}\n   YES ${yesPrice} | NO ${noPrice}`;
          });

          pendingTrades.set(chatId, { ...pending, event: selectedEvent, openMarkets });

          return bot.sendMessage(
            chatId,
            `*${selectedEvent.title}*\n\n${marketLines.join("\n\n")}\n\nReply: *market number* + *YES* or *NO*\ne.g. \`1 YES\` or \`2 NO\`\n\n_/cancel to abort_`,
            { parse_mode: "Markdown" }
          );
        }

        if (pending?.event && pending?.openMarkets) {
          const parts   = text.toUpperCase().split(/\s+/);
          const num     = parseInt(parts[0]);
          const outcome = parts[1];

          if (isNaN(num) || num < 1 || num > pending.openMarkets.length) {
            return bot.sendMessage(chatId, `❌ Send market number (1–${pending.openMarkets.length}) then YES or NO`);
          }
          if (!outcome || !["YES", "NO"].includes(outcome)) {
            return bot.sendMessage(chatId, `❌ Include YES or NO — e.g. \`${num} YES\``);
          }

          const market = pending.openMarkets[num - 1];
          pendingTrades.set(chatId, { ...pending, market, outcome, openMarkets: undefined });
          updateUser(chatId, { setup_step: TRADE_STEPS.AWAITING_AMOUNT });

          const price = outcome === "YES"
            ? market.outcome1Price ? `${(market.outcome1Price * 100).toFixed(0)}¢` : "—"
            : market.outcome2Price ? `${(market.outcome2Price * 100).toFixed(0)}¢` : "—";

          const minAmount = (user.currency || "USD") === "NGN" ? 100 : 1;

          return bot.sendMessage(
            chatId,
            `✅ *${pending.event.title}*\nMarket: ${market.title || market.outcome1Label}\nPosition: *${outcome}* @ ${price}\n\nHow much? (${user.currency || "USD"})\nMin: ${minAmount} | Max: ${user.max_trade_usd || 5}\n\n_/cancel to abort_`,
            { parse_mode: "Markdown" }
          );
        }

        updateUser(chatId, { setup_step: null });
        return bot.sendMessage(chatId, `❌ Session expired. Start again with /trade`);
      }

      case TRADE_STEPS.AWAITING_AMOUNT: {
        const minAmount = (user.currency || "USD") === "NGN" ? 100 : 1;
        const amount    = parseFloat(text);
        if (isNaN(amount) || amount < minAmount) {
          return bot.sendMessage(chatId, `❌ Minimum amount is ${minAmount} ${user.currency || "USD"}`);
        }

        const pending = pendingTrades.get(chatId);
        if (!pending?.event) {
          updateUser(chatId, { setup_step: null });
          return bot.sendMessage(chatId, `❌ Session expired. Start again with /trade`);
        }

        await bot.sendMessage(chatId, `🔄 _Getting quote..._`, { parse_mode: "Markdown" });

        try {
          const { getQuote, resolveOutcomeId } = await import("../bayse/client.js");
          const { decrypt: _decrypt }           = await import("../utils/encryption.js");
          const pubKey    = _decrypt(user.bayse_pub_key);
          const currency  = user.currency || "USD";
          const outcomeId = resolveOutcomeId(pending.market, pending.outcome);
          const quote     = await getQuote(pubKey, pending.event.id, pending.market.id, outcomeId, "BUY", amount, currency);

          pendingTrades.set(chatId, { ...pending, amount, quote });
          updateUser(chatId, { setup_step: TRADE_STEPS.AWAITING_CONFIRM });

          return bot.sendMessage(
            chatId,
            `📊 *Trade Quote*\n\n` +
            `Event: *${pending.event.title}*\n` +
            `Position: *BUY ${pending.outcome}*\n` +
            `Amount: *${currency} ${amount}*\n\n` +
            `Entry price: \`${((quote.price || quote.expectedPrice) * 100).toFixed(1)}¢\`\n` +
            `Shares: \`${quote.quantity?.toFixed(2) || "—"}\`\n` +
            `Fee: \`${quote.fee?.toFixed(2) || "0"}\`\n\n` +
            `Reply *CONFIRM* to place this trade or /cancel to abort.`,
            { parse_mode: "Markdown" }
          );
        } catch (err) {
          updateUser(chatId, { setup_step: null });
          pendingTrades.delete(chatId);
          return bot.sendMessage(chatId, `❌ Quote failed: ${err.message}`);
        }
      }

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
          const { decrypt: _dec }                           = await import("../utils/encryption.js");
          const { insertTrade: _insert }                    = await import("../db/database.js");

          const pubKey     = _dec(user.bayse_pub_key);
          const secKey     = _dec(user.bayse_sec_key);
          const currency   = user.currency || "USD";
          const _outcomeId = _resolve(pending.market, pending.outcome);

          const safeAmount = currency === "NGN"
            ? Math.max(Math.round(pending.amount), 100)
            : Math.max(pending.amount, 1);

          await placeOrder(pubKey, secKey, pending.event.id, pending.market.id, {
            side: "BUY", outcomeId: _outcomeId, amount: safeAmount, type: "MARKET", currency,
          });

          _insert({
            chat_id: String(chatId), event_id: pending.event.id, market_id: pending.market.id,
            event_title: pending.event.title, signal_source: "manual", confidence: 1.0,
            side: "BUY", outcome: pending.outcome, amount: safeAmount, currency,
            expected_price: pending.quote?.price || pending.quote?.expectedPrice || null, status: "open",
          });

          pendingTrades.delete(chatId);
          updateUser(chatId, { setup_step: null });

          return bot.sendMessage(
            chatId,
            `✅ *Trade Placed*\n\n*${pending.event.title}*\nBUY ${pending.outcome} | ${currency} ${safeAmount}\nEntry: \`${((pending.quote?.price || pending.quote?.expectedPrice) * 100).toFixed(1)}¢\`\n\n_Track it with /trades_`,
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
