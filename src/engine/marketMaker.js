// CLOB Market Maker
// Places two-sided limit orders (bid + ask) around the midpoint of a market
// Earns spread + Bayse liquidity rewards
// Separate from the signal engine — runs on demand via /makemarket

import { placeOrder, cancelOrder, getOpenOrders, getEvents, resolveOutcomeId } from "../bayse/client.js";
import { decrypt } from "../utils/encryption.js";
import { getPool } from "../db/database.js";

// How far from midpoint to place orders (spread)
// 0.05 = 5¢ each side — tight enough to get filled, wide enough to earn
const DEFAULT_SPREAD = parseFloat(process.env.MM_SPREAD || "0.05");

// How much liquidity to provide per side
const DEFAULT_MM_AMOUNT = parseFloat(process.env.MM_AMOUNT_PER_SIDE || "200"); // NGN

let activeMakerIntervals = new Map(); // chatId → intervalId
let bot = null;

export function setMarketMakerBot(botInstance) { bot = botInstance; }

// Start market making on a specific event/market for a user
export async function startMarketMaking(user, eventId, marketId, options = {}) {
  const chatId   = String(user.chat_id);
  const pubKey   = decrypt(user.bayse_pub_key);
  const secKey   = decrypt(user.bayse_sec_key);
  const currency = user.currency || "NGN";
  const spread   = options.spread || DEFAULT_SPREAD;
  const amount   = options.amount || DEFAULT_MM_AMOUNT;

  // Stop existing maker for this user if any
  stopMarketMaking(chatId);

  console.log(`[MarketMaker] Starting for ${chatId} on market ${marketId}`);

  // Run immediately then every 5 minutes
  await runMakerCycle(user, pubKey, secKey, eventId, marketId, currency, spread, amount);

  const intervalId = setInterval(
    () => runMakerCycle(user, pubKey, secKey, eventId, marketId, currency, spread, amount),
    5 * 60 * 1000
  );

  activeMakerIntervals.set(chatId, { intervalId, eventId, marketId });
  return true;
}

export function stopMarketMaking(chatId) {
  const active = activeMakerIntervals.get(String(chatId));
  if (active) {
    clearInterval(active.intervalId);
    activeMakerIntervals.delete(String(chatId));
    console.log(`[MarketMaker] Stopped for ${chatId}`);
  }
}

export function getActiveMakers() {
  return activeMakerIntervals.size;
}

export function isUserMaking(chatId) {
  return activeMakerIntervals.has(String(chatId));
}

async function runMakerCycle(user, pubKey, secKey, eventId, marketId, currency, spread, amount) {
  const chatId = String(user.chat_id);

  try {
    // Fetch current market to get midpoint price
    const events = await getEvents(pubKey, { status: "open", size: 50 });
    const event  = events.find(e => e.id === eventId);
    if (!event) {
      console.log(`[MarketMaker] Event ${eventId} not found or closed — stopping`);
      stopMarketMaking(chatId);
      if (bot) await bot.sendMessage(chatId,
        `⏹ *Market Making Stopped*\n\nEvent is no longer open.\n\n_/makemarket to start on a new market_`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const market = (event.markets || []).find(m => m.id === marketId || m.status === "open");
    if (!market) return;

    const midpoint = market.outcome1Price || 0.5;
    const bidPrice = Math.max(midpoint - spread, 0.05);
    const askPrice = Math.min(midpoint + spread, 0.95);

    const { outcomeId: yesId } = resolveOutcomeId(market, "YES");
    const { outcomeId: noId  } = resolveOutcomeId(market, "NO");

    // Cancel existing orders first to refresh quotes
    try {
      const existing = await getOpenOrders(pubKey, secKey, eventId, marketId);
      const orders   = existing?.orders || existing?.data || [];
      for (const order of orders) {
        await cancelOrder(pubKey, secKey, eventId, marketId, order.id);
      }
    } catch (err) {
      console.log(`[MarketMaker] Cancel existing orders failed (may be none): ${err.message}`);
    }

    // Place BID — buy YES cheap
    await placeOrder(pubKey, secKey, eventId, marketId, {
      type:      "LIMIT",
      side:      "BUY",
      outcomeId: yesId,
      amount,
      price:     bidPrice,
      currency,
    });

    // Place ASK — buy NO cheap (equivalent to selling YES expensive)
    await placeOrder(pubKey, secKey, eventId, marketId, {
      type:      "LIMIT",
      side:      "BUY",
      outcomeId: noId,
      amount,
      price:     1 - askPrice,
      currency,
    });

    console.log(
      `[MarketMaker] ${chatId} — bid:${bidPrice.toFixed(3)} ask:${askPrice.toFixed(3)} ` +
      `spread:${(spread * 2 * 100).toFixed(1)}¢ amount:${currency} ${amount} each side`
    );

  } catch (err) {
    console.error(`[MarketMaker] Cycle error for ${chatId}:`, err.message);
  }
}

// Get market suggestions for market making — highest volume open markets
export async function getSuggestedMakerMarkets(publicKey) {
  try {
    const allEvents = await getEvents(publicKey, { status: "open", size: 100 });
    return allEvents
      .filter(e => e.engine === "CLOB" || e.markets?.some(m => m.engine === "CLOB"))
      .sort((a, b) => (b.totalOrders || 0) - (a.totalOrders || 0))
      .slice(0, 5);
  } catch (err) {
    console.error("[MarketMaker] Suggestions failed:", err.message);
    return [];
  }
}
