import { encrypt, decrypt } from "../utils/encryption.js";
import { validateKeys }     from "../bayse/client.js";
import { runAllSignals }    from "../signals/index.js";
import {
  upsertUser, getUser, updateUser,
  getRecentTrades, getPnL,
} from "../db/database.js";
import { getEngineStatus }  from "../engine/engineLoop.js";

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

function arrow(direction) {
  if (!direction) return "→";
  const d = direction.toUpperCase();
  if (["UP","YES","BULLISH"].includes(d)) return "↑";
  if (["DOWN","NO","BEARISH"].includes(d)) return "↓";
  return "→";
}

export function registerCommands(bot) {

  // /start
  bot.onText(/\/start/, async msg => {
    const chatId = msg.chat.id;
    await upsertUser(chatId, msg.from?.username);
    const user      = await getUser(chatId);
    const connected = user?.bayse_pub_key;
    const running   = user?.engine_active;

    if (connected && running) {
      return bot.sendMessage(chatId,
        `"The market knows before you do.\nHarbinger just listens first."\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `HARBINGER  //  engine online\n\n` +
        `Your engine is running. Signals are live.\n` +
        `Trades fire automatically when confidence\n` +
        `crosses your threshold.\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `→ /status    engine overview\n` +
        `→ /signals   live signal report\n` +
        `→ /trades    recent trade history\n` +
        `→ /pnl       performance summary\n` +
        `→ /stop      halt the engine`
      );
    }

    if (connected && !running) {
      return bot.sendMessage(chatId,
        `"The market knows before you do.\nHarbinger just listens first."\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `HARBINGER  //  engine offline\n\n` +
        `Your keys are connected but the engine\n` +
        `is not running. Start it when ready.\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `→ /run       start the engine\n` +
        `→ /setup     reconfigure settings\n` +
        `→ /signals   check live signals\n` +
        `→ /status    engine overview`
      );
    }

    return bot.sendMessage(chatId,
      `"The market knows before you do.\nHarbinger just listens first."\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `HARBINGER\n\n` +
      `An autonomous signal engine built for\n` +
      `Bayse prediction markets.\n\n` +
      `It watches 4 live data sources — crypto\n` +
      `momentum, BTC precision signals, news\n` +
      `sentiment, and sports market activity —\n` +
      `then computes a composite confidence score\n` +
      `every 60 seconds.\n\n` +
      `When the score crosses your threshold,\n` +
      `it trades. You just watch.\n\n` +
      `No charts. No manual entries.\n` +
      `No emotion. Just signals → trades.\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `What Harbinger tracks:\n\n` +
      `⬡ Crypto momentum  — BTC, ETH, SOL, BNB\n` +
      `⬡ BTC 15m signal   — RSI + volume + trend\n` +
      `⬡ News sentiment   — 9 live RSS feeds\n` +
      `⬡ Sports markets   — activity + contestedness\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Your keys. Your trades. Your edge.\n\n` +
      `→ /connect   link your Bayse API keys\n` +
      `→ /setup     configure your engine\n` +
      `→ /run       start trading`
    );
  });

  // /connect
  bot.onText(/\/connect/, async msg => {
    await upsertUser(msg.chat.id, msg.from?.username);
    await updateUser(msg.chat.id, { setup_step: STEP.PUB });
    return bot.sendMessage(msg.chat.id,
      `HARBINGER  //  key setup\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Step 1 of 2 — Public Key\n\n` +
      `Send your Bayse PUBLIC key.\n` +
      `Starts with pk_live_...\n\n` +
      `Find it at app.bayse.markets\n` +
      `→ Settings → API Keys\n\n` +
      `/cancel to abort`
    );
  });

  // /disconnect
  bot.onText(/\/disconnect/, async msg => {
    await updateUser(msg.chat.id, {
      bayse_pub_key: null,
      bayse_sec_key: null,
      engine_active: 0,
      setup_step:    null,
    });
    return bot.sendMessage(msg.chat.id,
      `HARBINGER  //  disconnected\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Keys removed. Engine stopped.\n` +
      `All credentials wiped from storage.\n\n` +
      `→ /connect to reconnect`
    );
  });

  // /setup
  bot.onText(/\/setup/, async msg => {
    const user = await getUser(msg.chat.id);
    if (!user?.bayse_pub_key) {
      return bot.sendMessage(msg.chat.id,
        `No keys connected.\n\n→ /connect to add your Bayse API keys first.`
      );
    }
    await updateUser(msg.chat.id, { setup_step: STEP.THRESHOLD });
    return bot.sendMessage(msg.chat.id,
      `HARBINGER  //  setup  [1/3]\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Confidence Threshold\n\n` +
      `The minimum composite signal score\n` +
      `required before a trade fires.\n\n` +
      `  0.55 — more trades, more risk\n` +
      `  0.65 — balanced (recommended)\n` +
      `  0.80 — conservative, fewer trades\n\n` +
      `Current: ${user.threshold || 0.6}\n\n` +
      `Send a number between 0.5 and 0.95:`
    );
  });

  // /run
  bot.onText(/\/run/, async msg => {
    const user = await getUser(msg.chat.id);
    if (!user?.bayse_pub_key || !user?.bayse_sec_key) {
      return bot.sendMessage(msg.chat.id,
        `No keys connected.\n\n→ /connect to add your Bayse API keys first.`
      );
    }
    await updateUser(msg.chat.id, { engine_active: 1, setup_step: null });
    return bot.sendMessage(msg.chat.id,
      `HARBINGER  //  engine online\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Signals are live. Watching markets.\n` +
      `Trades fire when composite confidence\n` +
      `crosses your threshold.\n\n` +
      `→ /status    check engine state\n` +
      `→ /signals   live signal report\n` +
      `→ /pause     pause without stopping\n` +
      `→ /stop      halt the engine`
    );
  });

  // /pause
  bot.onText(/\/pause/, async msg => {
    await updateUser(msg.chat.id, { engine_active: 0 });
    return bot.sendMessage(msg.chat.id,
      `HARBINGER  //  paused\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Engine paused. No trades will fire.\n` +
      `Signals are still running.\n\n` +
      `→ /resume to continue`
    );
  });

  // /resume
  bot.onText(/\/resume/, async msg => {
    const user = await getUser(msg.chat.id);
    if (!user?.bayse_pub_key) {
      return bot.sendMessage(msg.chat.id, `No keys connected.\n\n→ /connect first.`);
    }
    await updateUser(msg.chat.id, { engine_active: 1 });
    return bot.sendMessage(msg.chat.id,
      `HARBINGER  //  resumed\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Engine is back online.\n` +
      `Watching for signal breach.\n\n` +
      `→ /status to check engine state`
    );
  });

  // /stop
  bot.onText(/\/stop/, async msg => {
    await updateUser(msg.chat.id, { engine_active: 0, setup_step: null });
    return bot.sendMessage(msg.chat.id,
      `HARBINGER  //  engine offline\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Engine stopped. No trades will fire.\n` +
      `Your keys remain connected.\n\n` +
      `→ /run to restart`
    );
  });

  // /status
  bot.onText(/\/status/, async msg => {
    const user   = await getUser(msg.chat.id);
    const engine = getEngineStatus();
    const state  = user?.engine_active ? "ONLINE  ▶" : "OFFLINE  ◼";
    const cat    = user?.preferred_category || "all";

    return bot.sendMessage(msg.chat.id,
      `HARBINGER  //  status\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Engine       ${state}\n` +
      `Threshold    ${user?.threshold || 0.6}\n` +
      `Max trade    ₦${user?.max_trade_amount || 200}\n` +
      `Category     ${cat}\n` +
      `Active users ${engine.activeUsers}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `→ /signals   live signal report\n` +
      `→ /trades    recent history\n` +
      `→ /pnl       performance`
    );
  });

  // /signals
  bot.onText(/\/signals/, async msg => {
    await bot.sendMessage(msg.chat.id, `HARBINGER  //  scanning signals...`);
    try {
      const user    = await getUser(msg.chat.id);
      const pubKey  = user?.bayse_pub_key ? decrypt(user.bayse_pub_key) : null;
      const signals = await runAllSignals(pubKey);
      const comp    = signals.composite;
      const state   = comp >= 0.7 ? "🔥 HOT" : comp >= 0.6 ? "⚡ WARM" : "◼ WATCHING";

      return bot.sendMessage(msg.chat.id,
        `HARBINGER  //  signal report\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Crypto    ${bar(signals.crypto.score)}  ${arrow(signals.crypto.direction)}\n` +
        `BTC 15m   ${bar(signals.btc15m.score)}  ${arrow(signals.btc15m.direction)}\n` +
        `Sentiment ${bar(signals.sentiment.score)}  ${arrow(signals.sentiment.direction)}\n` +
        `Sports    ${bar(signals.sports.score)}  ${arrow(signals.sports.direction)}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Composite ${bar(comp)}\n\n` +
        `${state}`
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
      `HARBINGER  //  category\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Set your preferred market category.\n` +
      `Harbinger will only trade markets\n` +
      `in this category when set.\n\n` +
      `Current: ${user?.preferred_category || "all"}\n\n` +
      CATEGORIES.map((c, i) => `  ${i + 1}. ${c}`).join("\n") +
      `\n\nSend the category name:`
    );
  });

  // /markets
  bot.onText(/\/markets/, async msg => {
    const user = await getUser(msg.chat.id);
    await bot.sendMessage(msg.chat.id, `HARBINGER  //  fetching markets...`);
    try {
      const pubKey = user?.bayse_pub_key ? decrypt(user.bayse_pub_key) : null;
      const res    = await fetch(`https://relay.bayse.markets/v1/pm/events?status=open&size=8&currency=NGN`, {
        headers: pubKey ? { "X-Public-Key": pubKey } : {},
      });
      const data   = await res.json();
      const events = data?.events || [];
      if (!events.length) {
        return bot.sendMessage(msg.chat.id, `HARBINGER  //  no open markets found.`);
      }
      const lines = events.map((e, i) => {
        const m   = e.markets?.find(mk => mk.status === "open");
        const yes = m ? `${(m.outcome1Price * 100).toFixed(0)}¢` : "—";
        const no  = m ? `${(m.outcome2Price * 100).toFixed(0)}¢` : "—";
        return `${i + 1}. ${e.title.slice(0, 42)}\n   YES ${yes}  NO ${no}  [${e.engine}]`;
      });
      return bot.sendMessage(msg.chat.id,
        `HARBINGER  //  open markets\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        lines.join("\n\n")
      );
    } catch (err) {
      return bot.sendMessage(msg.chat.id, `Error fetching markets: ${err.message}`);
    }
  });

  // /trades
  bot.onText(/\/trades/, async msg => {
    const trades = await getRecentTrades(String(msg.chat.id), 8);
    if (!trades.length) {
      return bot.sendMessage(msg.chat.id,
        `HARBINGER  //  no trades yet\n\n` +
        `→ /run to start the engine`
      );
    }
    const lines = trades.map((t, i) => {
      const icon = t.status === "resolved"
        ? (t.pnl > 0 ? "✅" : "❌")
        : "⏳";
      const pnl  = t.pnl != null
        ? `  ${t.pnl > 0 ? "+" : ""}₦${Math.abs(t.pnl).toFixed(0)}`
        : "";
      return `${i + 1}. ${icon} ${t.event_title.slice(0, 35)}\n   ${t.outcome} · ₦${t.amount}${pnl}`;
    });
    return bot.sendMessage(msg.chat.id,
      `HARBINGER  //  recent trades\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      lines.join("\n\n") +
      `\n\n→ /pnl for full performance`
    );
  });

  // /pnl
  bot.onText(/\/pnl/, async msg => {
    const pnl = await getPnL(String(msg.chat.id));
    if (!pnl || pnl.total === 0) {
      return bot.sendMessage(msg.chat.id,
        `HARBINGER  //  no data yet\n\n` +
        `P&L tracks once markets resolve.\n` +
        `Keep the engine running.\n\n` +
        `→ /trades to see open positions`
      );
    }
    const rate    = ((pnl.wins / pnl.total) * 100).toFixed(1);
    const net     = pnl.net.toFixed(2);
    const netSign = pnl.net >= 0 ? "+" : "";

    return bot.sendMessage(msg.chat.id,
      `HARBINGER  //  performance\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Trades      ${pnl.total}\n` +
      `Wins        ${pnl.wins}  (${rate}%)\n` +
      `Losses      ${pnl.losses}\n\n` +
      `Net P&L     ${netSign}₦${net}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `→ /trades for detailed history`
    );
  });

  // /cancel
  bot.onText(/\/cancel/, async msg => {
    await updateUser(msg.chat.id, { setup_step: null });
    return bot.sendMessage(msg.chat.id,
      `Cancelled.\n\n→ /start to go back to the beginning`
    );
  });

  // ─── Message handler ──────────────────────────────────────────────────────
  bot.on("message", async msg => {
    if (!msg.text || msg.text.startsWith("/")) return;
    const chatId = msg.chat.id;
    const user   = await getUser(chatId);
    if (!user?.setup_step) return;

    const text = msg.text.trim();

    switch (user.setup_step) {

      case STEP.PUB: {
        if (!text.startsWith("pk_")) {
          return bot.sendMessage(chatId,
            `Invalid key format.\nMust start with pk_live_...\n\nTry again or /cancel to abort.`
          );
        }
        await updateUser(chatId, { bayse_pub_key: encrypt(text), setup_step: STEP.SEC });
        return bot.sendMessage(chatId,
          `HARBINGER  //  key setup  [2/2]\n\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `Step 2 of 2 — Secret Key\n\n` +
          `Now send your Bayse SECRET key.\n` +
          `Starts with sk_live_...\n\n` +
          `This key is encrypted and never\n` +
          `exposed outside your engine.\n\n` +
          `/cancel to abort`
        );
      }

      case STEP.SEC: {
        if (!text.startsWith("sk_")) {
          return bot.sendMessage(chatId,
            `Invalid key format.\nMust start with sk_live_...\n\nTry again or /cancel to abort.`
          );
        }
        const pub   = decrypt(user.bayse_pub_key);
        const check = await validateKeys(pub, text);
        if (!check.valid) {
          return bot.sendMessage(chatId,
            `Key validation failed.\n${check.error}\n\nCheck your keys and try /connect again.`
          );
        }
        await updateUser(chatId, { bayse_sec_key: encrypt(text), setup_step: null });
        return bot.sendMessage(chatId,
          `HARBINGER  //  connected\n\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `Keys verified and encrypted.\n` +
          `Your credentials are stored securely.\n\n` +
          `→ /setup     configure your engine\n` +
          `→ /run       start trading now`
        );
      }

      case STEP.THRESHOLD: {
        const v = parseFloat(text);
        if (isNaN(v) || v < 0.5 || v > 0.95) {
          return bot.sendMessage(chatId,
            `Must be between 0.5 and 0.95\n\nTry again:`
          );
        }
        await updateUser(chatId, { threshold: v, setup_step: STEP.LIMIT });
        return bot.sendMessage(chatId,
          `HARBINGER  //  setup  [2/3]\n\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `Threshold set to ${v}\n\n` +
          `Max Trade Amount\n\n` +
          `The maximum NGN amount per trade.\n` +
          `Harbinger scales trade size with\n` +
          `signal strength — this is the ceiling.\n\n` +
          `Minimum: ₦100\n\n` +
          `Send an amount in NGN:`
        );
      }

      case STEP.LIMIT: {
        const v = parseFloat(text);
        if (isNaN(v) || v < 100) {
          return bot.sendMessage(chatId,
            `Minimum is ₦100\n\nTry again:`
          );
        }
        await updateUser(chatId, { max_trade_amount: v, setup_step: STEP.CATEGORY });
        return bot.sendMessage(chatId,
          `HARBINGER  //  setup  [3/3]\n\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `Max trade set to ₦${v}\n\n` +
          `Market Category\n\n` +
          `Harbinger will only trade markets\n` +
          `in your preferred category.\n\n` +
          CATEGORIES.map((c, i) => `  ${i + 1}. ${c}`).join("\n") +
          `\n\nSend the category name:`
        );
      }

      case STEP.CATEGORY: {
        const v = text.toLowerCase();
        if (!CATEGORIES.includes(v)) {
          return bot.sendMessage(chatId,
            `Invalid category.\n\nOptions: ${CATEGORIES.join(", ")}\n\nTry again:`
          );
        }
        await updateUser(chatId, { preferred_category: v, setup_step: null });
        return bot.sendMessage(chatId,
          `HARBINGER  //  setup complete\n\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `Category set to ${v}.\n` +
          `Your engine is configured and ready.\n\n` +
          `→ /run to start trading`
        );
      }
    }
  });
}
