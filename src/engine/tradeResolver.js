import { getOpenTrades, updateTrade } from "../db/database.js";
import { getPortfolio, getEventById } from "../bayse/client.js";
import { decrypt }                    from "../utils/encryption.js";
import { calculateFee, recordLoss, recordWin } from "./riskManager.js";

let bot           = null;
let resolverTimer = null;

export function setResolverBot(botInstance) { bot = botInstance; }

export function startTradeResolver() {
  resolverTimer = setInterval(resolveOpenTrades, 2 * 60 * 1000);
  console.log("[Resolver] Started — checking every 2 min");
  setTimeout(resolveOpenTrades, 20_000);
}

export function stopTradeResolver() {
  if (resolverTimer) clearInterval(resolverTimer);
}

async function resolveOpenTrades() {
  try {
    const openTrades = await getOpenTrades();
    if (!openTrades.length) return;

    console.log(`[Resolver] Checking ${openTrades.length} open trade(s)`);

    for (const trade of openTrades) {
      try {
        await resolveSingleTrade(trade);
      } catch (err) {
        console.error(`[Resolver] Trade ${trade.id} error:`, err.message);
      }
    }
  } catch (err) {
    console.error("[Resolver] Error:", err.message);
  }
}

async function resolveSingleTrade(trade) {
  const pubKey = decrypt(trade.bayse_pub_key);
  const secKey = decrypt(trade.bayse_sec_key);

  try {
    const event    = await getEventById(pubKey, trade.event_id);
    const resolved = await tryResolveFromEvent(trade, event);
    if (resolved) return;
  } catch (err) {
    console.log(`[Resolver] Event fetch failed for trade ${trade.id}: ${err.message}`);
  }

  try {
    await tryResolveFromPortfolio(trade, pubKey, secKey);
  } catch (err) {
    console.log(`[Resolver] Portfolio check failed for trade ${trade.id}: ${err.message}`);
  }
}

async function tryResolveFromEvent(trade, event) {
  if (!event) return false;

  const markets = event.markets || event.data?.markets || [];
  const market  = markets.find(m =>
    m.id === trade.market_id || m.marketId === trade.market_id
  ) || markets[0];

  if (!market) return false;

  const marketStatus = (market.status || market.marketStatus || "").toLowerCase();
  const eventStatus  = (event.status  || event.eventStatus  || "").toLowerCase();

  const isResolved = ["resolved", "settled", "closed", "completed", "finished"]
    .some(s => marketStatus.includes(s) || eventStatus.includes(s));

  if (!isResolved) {
    console.log(`[Resolver] Trade ${trade.id} — status: ${marketStatus || eventStatus} (pending)`);
    return false;
  }

  const winningOutcomeId = market.winningOutcomeId
    || market.resolvedOutcomeId
    || market.result
    || market.winner;

  let won = null;

  if (winningOutcomeId) {
    const ourOutcome    = trade.outcome;
    const outcome1Wins  = winningOutcomeId === market.outcome1Id;
    const outcome1Label = (market.outcome1Label || "").toUpperCase();

    if (outcome1Label === "YES" || outcome1Label.includes("UP")) {
      won = outcome1Wins ? ourOutcome === "YES" : ourOutcome === "NO";
    } else {
      won = outcome1Wins
        ? (trade.outcome_label || ourOutcome) === (market.outcome1Label || "")
        : (trade.outcome_label || ourOutcome) === (market.outcome2Label || "");
    }
  }

  const entryPrice = trade.expected_price || 0.5;
  const amount     = trade.amount;
  let   rawPnl;

  if (won === true)       rawPnl = parseFloat((amount * (1 - entryPrice) / entryPrice).toFixed(2));
  else if (won === false) rawPnl = -amount;
  else                    return false;

  await settleTradeRecord(trade, rawPnl);
  return true;
}

// Bayse portfolio shape: { outcomeBalances: [...] }
// Each entry: { cost, currentValue, currency, market: { id, event: { id, status } } }
async function tryResolveFromPortfolio(trade, pubKey, secKey) {
  const portfolio = await getPortfolio(pubKey, secKey);
  const balances  = portfolio?.outcomeBalances;

  if (!Array.isArray(balances)) {
    console.log(`[Resolver] Trade ${trade.id} — unexpected portfolio shape:`, Object.keys(portfolio || {}));
    return;
  }

  const entry = balances.find(b =>
    b.market?.id        === trade.market_id ||
    b.market?.event?.id === trade.event_id
  );

  if (!entry) {
    console.log(`[Resolver] Trade ${trade.id} — not found in outcomeBalances`);
    return;
  }

  const eventStatus = (entry.market?.event?.status || "").toLowerCase();
  const isSettled   = ["resolved", "settled", "closed", "completed", "finished"]
    .some(s => eventStatus.includes(s));

  if (!isSettled) {
    console.log(`[Resolver] Trade ${trade.id} — portfolio entry found, event not yet settled (${eventStatus})`);
    return;
  }

  const cost         = Number(entry.cost         || 0);
  const currentValue = Number(entry.currentValue || 0);
  const rawPnl       = parseFloat((currentValue - cost).toFixed(2));

  console.log(`[Resolver] Trade ${trade.id} — portfolio settled | cost:${cost} value:${currentValue} pnl:${rawPnl}`);
  await settleTradeRecord(trade, rawPnl);
}

async function settleTradeRecord(trade, rawPnl) {
  const { userPnl, platformFee } = calculateFee(rawPnl);

  await updateTrade(trade.id, {
    status:      "resolved",
    pnl:         userPnl,
    resolved_at: new Date().toISOString(),
  });

  if (userPnl > 0) recordWin(trade.chat_id,  userPnl);
  else              recordLoss(trade.chat_id, Math.abs(userPnl));

  console.log(
    `[Resolver] Trade ${trade.id} settled | ` +
    `raw:${rawPnl} fee:${platformFee} user:${userPnl} ${trade.currency}`
  );

  if (!bot) return;

  const icon   = userPnl > 0 ? "✅" : userPnl === 0 ? "⚪" : "❌";
  const result = userPnl > 0 ? "Won" : userPnl === 0 ? "Pushed" : "Lost";
  const pnlStr = `${userPnl >= 0 ? "+" : ""}${userPnl.toFixed(2)} ${trade.currency}`;
  const feeStr = platformFee > 0 ? `\nFee: ${platformFee.toFixed(2)} ${trade.currency}` : "";

  await bot.sendMessage(
    trade.chat_id,
    `${icon} Trade Settled\n\n` +
    `${trade.event_title}\n` +
    `${trade.side} ${trade.outcome_label || trade.outcome}\n` +
    `${trade.currency} ${trade.amount} @ ${(trade.expected_price * 100).toFixed(1)}c\n\n` +
    `Result: ${result}\n` +
    `P&L: ${pnlStr}${feeStr}\n\n` +
    `/pnl for your full summary`
  ).catch(err => console.error(`[Resolver] Notify failed:`, err.message));
}
