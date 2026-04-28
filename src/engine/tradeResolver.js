import { getOpenTrades, updateTrade } from "../db/database.js";
import { getPortfolio }               from "../bayse/client.js";
import { decrypt }                    from "../utils/encryption.js";

let bot = null;
let resolverTimer = null;

export function setResolverBot(botInstance) { bot = botInstance; }

export function startTradeResolver() {
  // Check every 5 minutes
  resolverTimer = setInterval(resolveOpenTrades, 5 * 60 * 1000);
  console.log("[Resolver] Trade resolver started — checking every 5 min");
}

export function stopTradeResolver() {
  if (resolverTimer) clearInterval(resolverTimer);
}

async function resolveOpenTrades() {
  try {
    const openTrades = await getOpenTrades();
    if (!openTrades.length) return;

    console.log(`[Resolver] Checking ${openTrades.length} open trade(s)`);

    // Group trades by user to minimize API calls
    const byUser = {};
    for (const trade of openTrades) {
      if (!byUser[trade.chat_id]) byUser[trade.chat_id] = [];
      byUser[trade.chat_id].push(trade);
    }

    for (const [chatId, trades] of Object.entries(byUser)) {
      try {
        const pubKey = decrypt(trades[0].bayse_pub_key);
        const secKey = decrypt(trades[0].bayse_sec_key);
        const portfolio = await getPortfolio(pubKey, secKey);

        // Portfolio returns positions — match by event_id + market_id
        const positions = portfolio?.positions || portfolio?.data || [];

        for (const trade of trades) {
          const position = positions.find(
            p => p.eventId === trade.event_id || p.marketId === trade.market_id
          );

          if (!position) continue;

          // Position is resolved when it has a pnl/profit field and status is settled/resolved
          const isResolved = position.status === "resolved" || position.status === "settled" || position.profit != null;
          if (!isResolved) continue;

          const pnl = parseFloat(position.profit || position.pnl || 0);

          await updateTrade(trade.id, {
            status:      "resolved",
            pnl,
            resolved_at: new Date().toISOString(),
          });

          console.log(`[Resolver] Trade ${trade.id} resolved — P&L: ${pnl}`);

          // Notify user
          if (bot) {
            const emoji  = pnl > 0 ? "✅" : "❌";
            const result = pnl > 0 ? "Won" : "Lost";
            await bot.sendMessage(
              chatId,
              `${emoji} *Trade Settled*\n\n` +
              `📋 ${trade.event_title}\n` +
              `📌 ${trade.side} ${trade.outcome_label || trade.outcome}\n` +
              `💰 ${trade.currency} ${trade.amount}\n\n` +
              `*Result:* ${result}\n` +
              `*P&L:* \`${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} ${trade.currency}\`\n\n` +
              `_/pnl to see your full summary_`,
              { parse_mode: "Markdown" }
            );
          }
        }
      } catch (err) {
        console.error(`[Resolver] User ${chatId} portfolio check failed:`, err.message);
      }
    }
  } catch (err) {
    console.error("[Resolver] Error:", err.message);
  }
}
