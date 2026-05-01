import { getUser, updateUser } from "../db/database.js";
import { decrypt } from "../utils/encryption.js";
import { startMarketMaking, stopMarketMaking, isUserMaking, getSuggestedMakerMarkets } from "../engine/marketMaker.js";
import { getEvents } from "../bayse/client.js";

export function registerMarketMakerCommands(bot) {

  // ─── /makemarket ─────────────────────────────────────────────────────────────
  bot.onText(/\/makemarket/, async (msg) => {
    const chatId = msg.chat.id;
    const user   = await getUser(chatId);

    if (!user?.bayse_pub_key || !user?.bayse_sec_key) {
      return bot.sendMessage(chatId, `❌ Connect your Bayse keys first with /connect`);
    }

    if (isUserMaking(chatId)) {
      return bot.sendMessage(
        chatId,
        `⚡ *Market Making Active*\n\nYou're already providing liquidity.\n\n/stopmaking — stop market making\n/makingstatus — check your activity`,
        { parse_mode: "Markdown" }
      );
    }

    await bot.sendMessage(chatId, `🔄 _Finding best CLOB markets for liquidity provision..._`, { parse_mode: "Markdown" });

    try {
      const pubKey  = decrypt(user.bayse_pub_key);
      const markets = await getSuggestedMakerMarkets(pubKey);

      if (!markets.length) {
        return bot.sendMessage(
          chatId,
          `📭 *No CLOB markets available right now*\n\nHarbinger places limit orders on CLOB markets to earn spread and liquidity rewards.\n\nCheck back when more CLOB markets are open.`,
          { parse_mode: "Markdown" }
        );
      }

      const lines = markets.map((e, i) => {
        const market  = e.markets?.find(m => m.status === "open");
        const yes     = market?.outcome1Price ? `${(market.outcome1Price * 100).toFixed(0)}¢` : "—";
        const no      = market?.outcome2Price ? `${(market.outcome2Price * 100).toFixed(0)}¢` : "—";
        const orders  = e.totalOrders || 0;
        return `*${i + 1}.* ${e.title?.slice(0, 45)}\n   YES ${yes} | NO ${no} | ${orders} orders`;
      });

      // Store pending market selection
      await updateUser(chatId, { setup_step: "mm_awaiting_market" });

      // Store markets in memory for this session
      bot._mmMarkets = bot._mmMarkets || {};
      bot._mmMarkets[chatId] = markets;

      return bot.sendMessage(
        chatId,
        `📊 *Market Making*\n\n` +
        `You'll provide two-sided liquidity — placing buy orders on both YES and NO sides.\n\n` +
        `✦ Earn spread on every fill\n` +
        `✦ Earn Bayse liquidity rewards\n` +
        `✦ Orders refresh every 5 minutes\n\n` +
        `*Available CLOB Markets:*\n\n${lines.join("\n\n")}\n\n` +
        `Reply with the *number* of the market to start, or /cancel to abort.`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      return bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
  });

  // ─── /stopmaking ─────────────────────────────────────────────────────────────
  bot.onText(/\/stopmaking/, async (msg) => {
    const chatId = msg.chat.id;

    if (!isUserMaking(chatId)) {
      return bot.sendMessage(chatId, `ℹ️ No active market making to stop.\n\n_/makemarket to start_`);
    }

    stopMarketMaking(chatId);
    return bot.sendMessage(
      chatId,
      `⏹ *Market Making Stopped*\n\nYour limit orders have been cancelled.\n\n_/makemarket to start again_`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── /makingstatus ───────────────────────────────────────────────────────────
  bot.onText(/\/makingstatus/, async (msg) => {
    const chatId = msg.chat.id;
    const active = isUserMaking(chatId);

    return bot.sendMessage(
      chatId,
      active
        ? `⚡ *Market Making Active*\n\nYou're providing two-sided liquidity.\n\nOrders refresh every 5 minutes automatically.\n\n_/stopmaking to pause_`
        : `⏸ *Market Making Inactive*\n\n_/makemarket to start earning liquidity rewards_`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── Text handler for market selection ───────────────────────────────────────
  bot.on("message", async (msg) => {
    if (msg.text?.startsWith("/")) return;
    const chatId = msg.chat.id;
    const text   = msg.text?.trim();
    if (!text) return;

    const user = await getUser(chatId);
    if (user?.setup_step !== "mm_awaiting_market") return;

    const num     = parseInt(text);
    const markets = bot._mmMarkets?.[chatId];

    if (!markets?.length) {
      await updateUser(chatId, { setup_step: null });
      return bot.sendMessage(chatId, `❌ Session expired. Run /makemarket again.`);
    }

    if (isNaN(num) || num < 1 || num > markets.length) {
      return bot.sendMessage(chatId, `❌ Send a number between 1 and ${markets.length}`);
    }

    const selectedEvent = markets[num - 1];
    const market        = selectedEvent.markets?.find(m => m.status === "open");

    if (!market) {
      return bot.sendMessage(chatId, `❌ No open market found. Try /makemarket again.`);
    }

    await updateUser(chatId, { setup_step: null });
    delete bot._mmMarkets[chatId];

    await bot.sendMessage(chatId, `🔄 _Starting market making on ${selectedEvent.title}..._`, { parse_mode: "Markdown" });

    try {
      const currency = user.currency || "NGN";
      const amount   = currency === "NGN" ? 200 : 2;

      await startMarketMaking(user, selectedEvent.id, market.id, { amount });

      const yes = market.outcome1Price ? `${(market.outcome1Price * 100).toFixed(0)}¢` : "—";
      const no  = market.outcome2Price ? `${(market.outcome2Price * 100).toFixed(0)}¢` : "—";

      return bot.sendMessage(
        chatId,
        `✅ *Market Making Started*\n\n` +
        `📋 *Market:* ${selectedEvent.title?.slice(0, 50)}\n` +
        `📊 *Spread:* YES ${yes} | NO ${no}\n` +
        `💰 *Per side:* ${currency} ${amount}\n\n` +
        `✦ Harbinger is now quoting both sides\n` +
        `✦ Orders refresh every 5 minutes\n` +
        `✦ Liquidity rewards accrue to your Bayse account\n\n` +
        `_/stopmaking to stop | /makingstatus to check_`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      return bot.sendMessage(chatId, `❌ Failed to start: ${err.message}`);
    }
  });
}
