import { encrypt, decrypt } from "../utils/encryption.js";
import { validateKeys }     from "../bayse/client.js";
import { runAllSignals }    from "../signals/index.js";
import {
  upsertUser, getUser, updateUser,
  getRecentTrades, getPnL,
} from "../db/database.js";
import { getEngineStatus }  from "../engine/engineLoop.js";
import { sendAlert }        from "./alerts.js";

const CATEGORIES = ["sports", "crypto", "politics", "entertainment", "finance", "all"];

const STEP = {
  PUB:       "pub",
  SEC:       "sec",
  THRESHOLD: "threshold",
  LIMIT:     "limit",
  CATEGORY:  "category",
};

function bar(score = 0.5) {
  const f = Math.round(Math.max(0, Math.min(1, score)) * 10);
  return "█".repeat(f) + "░".repeat(10 - f) + ` ${(score * 100).toFixed(0)}%`;
}

export function registerCommands(bot) {

  // /start
  bot.onText(/\/start/, async msg => {
    const chatId = msg.chat.id;
    await upsertUser(chatId, msg.from?.username);
    const user = await getUser(chatId);
    const connected = user?.bayse_pub_key;
    return bot.sendMessage(chatId,
      `Harbinger\nSignal-driven prediction engine\n\n` +
      (connected
        ? `/run — start\n/signals — live signals\n/status — engine status\n/trades — history\n/pnl — performance`
        : `/connect — add Bayse API keys\n/setup — configure engine`)
    );
  });

  // /connect
  bot.onText(/\/connect/, async msg => {
    await updateUser(msg.chat.id, { setup_step: STEP.PUB });
    return bot.sendMessage(msg.chat.id, "Send your Bayse PUBLIC key (starts with pk_):");
  });

  // /disconnect
  bot.onText(/\/disconnect/, async msg => {
    await updateUser(msg.chat.id, {
      bayse_pub_key: null, bayse_sec_key: null,
      engine_active: 0, setup_step: null,
    });
    return bot.sendMessage(msg.chat.id, "Keys removed. Engine stopped.");
  });

  // /setup
  bot.onText(/\/setup/, async msg => {
    const user = await getUser(msg.chat.id);
    if (!user?.bayse_pub_key) return bot.sendMessage(msg.chat.id, "Connect keys first with /connect");
    await updateUser(msg.chat.id, { setup_step: STEP.THRESHOLD });
    return bot.sendMessage(msg.chat.id,
      `Set confidence threshold (0.50–0.95)\nCurrent: ${user.threshold}\n\nSend a number:`
    );
  });

  // /run
  bot.onText(/\/run/, async msg => {
    const user = await getUser(msg.chat.id);
    if (!user?.bayse_pub_key || !user?.bayse_sec_key)
      return bot.sendMessage(msg.chat.id, "Connect keys first with /connect");
    await updateUser(msg.chat.id, { engine_active: 1, setup_step: null });
    return bot.sendMessage(msg.chat.id, "Engine started.\n\n/pause to pause | /stop to stop");
  });

  // /pause
  bot.onText(/\/pause/, async msg => {
    await updateUser(msg.chat.id, { engine_active: 0 });
    return bot.sendMessage(msg.chat.id, "Engine paused.\n\n/resume to continue");
  });

  // /resume
  bot.onText(/\/resume/, async msg => {
    const user = await getUser(msg.chat.id);
    if (!user?.bayse_pub_key) return bot.sendMessage(msg.chat.id, "Connect keys first.");
    await updateUser(msg.chat.id, { engine_active: 1 });
    return bot.sendMessage(msg.chat.id, "Engine resumed.");
  });

  // /stop
  bot.onText(/\/stop/, async msg => {
    await updateUser(msg.chat.id, { engine_active: 0, setup_step: null });
    return bot.sendMessage(msg.chat.id, "Engine stopped.\n\n/run to restart");
  });

  // /status
  bot.onText(/\/status/, async msg => {
    const user   = await getUser(msg.chat.id);
    const status = getEngineStatus();
    return bot.sendMessage(msg.chat.id,
      `Status\n\n` +
      `Engine: ${user?.engine_active ? "ON" : "OFF"}\n` +
      `Threshold: ${user?.threshold || 0.6}\n` +
      `Max trade: NGN ${user?.max_trade_amount || 200}\n` +
      `Category: ${user?.preferred_category || "all"}\n` +
      `Active users: ${status.activeUsers}`
    );
  });

  // /signals
  bot.onText(/\/signals/, async msg => {
    await bot.sendMessage(msg.chat.id, "Fetching signals...");
    try {
      const user    = await getUser(msg.chat.id);
      const pubKey  = user?.bayse_pub_key ? decrypt(user.bayse_pub_key) : null;
      const signals = await runAllSignals(pubKey);
      return bot.sendMessage(msg.chat.id,
        `Signal Report\n\n` +
        `Crypto    ${bar(signals.crypto.score)}  ${signals.crypto.direction || ""}\n` +
        `BTC 15m   ${bar(signals.btc15m.score)}  ${signals.btc15m.direction || ""}\n` +
        `Sentiment ${bar(signals.sentiment.score)}\n` +
        `Sports    ${bar(signals.sports.score)}\n\n` +
        `Composite ${bar(signals.composite)}`
      );
    } catch (err) {
      return bot.sendMessage(msg.chat.id, `Signal fetch failed: ${err.message}`);
    }
  });

  // /category
  bot.onText(/\/category/, async msg => {
    const user = await getUser(msg.chat.id);
    await updateUser(msg.chat.id, { setup_step: STEP.CATEGORY });
    return bot.sendMessage(msg.chat.id,
      `Set market category\nCurrent: ${user?.preferred_category || "all"}\n\n` +
      CATEGORIES.map((c, i) => `${i + 1}. ${c}`).join("\n") +
      `\n\nSend category name:`
    );
  });

  // /markets
  bot.onText(/\/markets/, async msg => {
    const user = await getUser(msg.chat.id);
    await bot.sendMessage(msg.chat.id, "Fetching open markets...");
    try {
      const pubKey = user?.bayse_pub_key ? decrypt(user.bayse_pub_key) : null;
      const res    = await fetch(`https://relay.bayse.markets/v1/pm/events?status=open&size=8&currency=NGN`, {
        headers: pubKey ? { "X-Public-Key": pubKey } : {},
      });
      const data   = await res.json();
      const events = data?.events || [];
      if (!events.length) return bot.sendMessage(msg.chat.id, "No open markets right now.");
      const lines  = events.map((e, i) => {
        const m = e.markets?.find(mk => mk.status === "open");
        return `${i + 1}. ${e.title.slice(0, 45)}\n   YES ${m ? (m.outcome1Price * 100).toFixed(0) + "¢" : "—"} | ${e.engine}`;
      });
      return bot.sendMessage(msg.chat.id, `Open Markets\n\n${lines.join("\n\n")}`);
    } catch (err) {
      return bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
  });

  // /trades
  bot.onText(/\/trades/, async msg => {
    const trades = await getRecentTrades(String(msg.chat.id), 8);
    if (!trades.length) return bot.sendMessage(msg.chat.id, "No trades yet. Run /run to start.");
    const lines = trades.map((t, i) => {
      const icon = t.status === "resolved" ? (t.pnl > 0 ? "✅" : "❌") : "⏳";
      const pnl  = t.pnl != null ? ` | ${t.pnl > 0 ? "+" : ""}${t.pnl.toFixed(0)}` : "";
      return `${i + 1}. ${icon} ${t.event_title.slice(0, 35)}\n   ${t.outcome} ₦${t.amount}${pnl}`;
    });
    return bot.sendMessage(msg.chat.id, `Recent Trades\n\n${lines.join("\n\n")}`);
  });

  // /pnl
  bot.onText(/\/pnl/, async msg => {
    const pnl = await getPnL(String(msg.chat.id));
    if (!pnl || pnl.total === 0) return bot.sendMessage(msg.chat.id, "No resolved trades yet.");
    const rate = ((pnl.wins / pnl.total) * 100).toFixed(1);
    return bot.sendMessage(msg.chat.id,
      `Performance\n\n` +
      `Trades: ${pnl.total} | Wins: ${pnl.wins} | Losses: ${pnl.losses}\n` +
      `Win rate: ${rate}%\n` +
      `Net P&L: NGN ${pnl.net > 0 ? "+" : ""}${pnl.net.toFixed(2)}`
    );
  });

  // /cancel
  bot.onText(/\/cancel/, async msg => {
    await updateUser(msg.chat.id, { setup_step: null });
    return bot.sendMessage(msg.chat.id, "Cancelled.");
  });

  // ─── Single message handler for all setup flows ───────────────────────────
  bot.on("message", async msg => {
    if (!msg.text || msg.text.startsWith("/")) return;
    const chatId = msg.chat.id;
    const user   = await getUser(chatId);
    if (!user?.setup_step) return;

    const text = msg.text.trim();

    switch (user.setup_step) {

      case STEP.PUB: {
        if (!text.startsWith("pk_"))
          return bot.sendMessage(chatId, "Invalid. Must start with pk_");
        await updateUser(chatId, { bayse_pub_key: encrypt(text), setup_step: STEP.SEC });
        return bot.sendMessage(chatId, "Got it. Now send your SECRET key (sk_...):");
      }

      case STEP.SEC: {
        if (!text.startsWith("sk_"))
          return bot.sendMessage(chatId, "Invalid. Must start with sk_");
        const pub   = decrypt(user.bayse_pub_key);
        const check = await validateKeys(pub, text);
        if (!check.valid)
          return bot.sendMessage(chatId, `Keys invalid: ${check.error}\n\nTry /connect again.`);
        await updateUser(chatId, { bayse_sec_key: encrypt(text), setup_step: null });
        return bot.sendMessage(chatId, "Keys saved and verified.\n\nRun /setup to configure, then /run to start.");
      }

      case STEP.THRESHOLD: {
        const v = parseFloat(text);
        if (isNaN(v) || v < 0.5 || v > 0.95)
          return bot.sendMessage(chatId, "Must be between 0.5 and 0.95");
        await updateUser(chatId, { threshold: v, setup_step: STEP.LIMIT });
        return bot.sendMessage(chatId, `Threshold set to ${v}.\n\nMax trade amount (NGN):`);
      }

      case STEP.LIMIT: {
        const v = parseFloat(text);
        if (isNaN(v) || v < 100)
          return bot.sendMessage(chatId, "Minimum is NGN 100");
        await updateUser(chatId, { max_trade_amount: v, setup_step: STEP.CATEGORY });
        return bot.sendMessage(chatId,
          `Max trade set to NGN ${v}.\n\nPreferred category?\n\n` +
          CATEGORIES.map((c, i) => `${i + 1}. ${c}`).join("\n") +
          `\n\nSend category name:`
        );
      }

      case STEP.CATEGORY: {
        const v = text.toLowerCase();
        if (!CATEGORIES.includes(v))
          return bot.sendMessage(chatId, `Invalid. Options: ${CATEGORIES.join(", ")}`);
        await updateUser(chatId, { preferred_category: v, setup_step: null });
        return bot.sendMessage(chatId, `Setup complete.\n\nCategory: ${v}\n\n/run to start the engine.`);
      }
    }
  });
}
