import { getOpenTrades, updateTrade } from "../db/database.js";
import { getPortfolio }               from "../bayse/client.js";
import { decrypt }                    from "../utils/encryption.js";
import { calculateFee, recordLoss, recordWin } from "./riskManager.js";

const PLATFORM_FEE_PCT = parseFloat(process.env.PLATFORM_FEE_PCT || "0.03");

let bot           = null;
let resolverTimer = null;

export function setResolverBot(botInstance) { bot = botInstance; }

export function startTradeResolver() {
  resolverTimer = setInterval(resolveOpenTrades, 3 * 60 * 1000);
  console.log("[Resolver] Trade resolver started — checking every 3 min");
  setTimeout(resolveOpenTrades, 15_000);
}

export function stopTradeResolver() {
  if (resolverTimer) clearInterval(resolverTimer);
}

async function resolveOpenTrades() {
  try {
    const openTrades = await getOpenTrades();
    if (!openTrades.length) return;

    console.log(`[Resolver] Checking ${openTrades.length} open trade(s)`);

    const byUser = {};
    for (const trade of openTrades) {
      if (!byUser[trade.chat_id]) byUser[trade.chat_id] = [];
      byUser[trade.chat_id].push(trade);
    }

    for (const [chatId, trades] of Object.entries(byUser)) {
      try {
        const pubKey    = decrypt(trades[0].bayse_pub_key);
        const secKey    = decrypt(trades[0].bayse_sec_key);
        const portfolio = await getPortfolio(pubKey, secKey);

        // Log raw shape for debugging — truncated
        console.log(`[Resolver] Portfolio shape for ${chatId}:`,
          JSON.stringify(Object.keys(portfolio || {})));

        const positions = (
          portfolio?.positions         ||
          portfolio?.data?.positions   ||
          portfolio?.orders            ||
          portfolio?.trades            ||
          portfolio?.data              ||
          []
        );

        if (!Array.isArray(positions)) {
          console.log(`[Resolver] Non-array portfolio — full:`, JSON.stringify(portfolio).slice(0, 800));
          continue;
        }

        for (const trade of trades) {
          const position = positions.find(p =>
            p.eventId    === trade.event_id  ||
            p.event_id   === trade.event_id  ||
            p.marketId   === trade.market_id ||
            p.market_id  === trade.market_id ||
            p.id         === trade.market_id
          );

          if (!position) continue;

          const status     = (position.status || position.settlementStatus || position.state || "").toLowerCase();
          const isResolved = ["resolved","settled","closed","won","lost","complete"].includes(status)
            || position.profit       != null
            || position.pnl          != null
            || position.returnAmount != null
            || position.winAmount    != null;

          if (!isResolved) continue;

          const rawPnl = parseFloat(
            position.profit       ??
            position.pnl          ??
            position.returnAmount ??
            position.winAmount    ??
            position.netPnl       ??
            0
          );

          // Apply platform fee on wins
          const { userPnl, platformFee } = calculateFee(rawPnl, trade.amount);

          await updateTrade(trade.id, {
            status:      "resolved",
            pnl:         userPnl,
            resolved_at: new Date().toISOString(),
          });

          // Update daily risk tracker
          if (userPnl > 0) recordWin(chatId, userPnl);
          else              recordLoss(chatId, Math.abs(userPnl));

          console.log(
            `[Resolver] Trade ${trade.id} resolved — ` +
            `raw P&L: ${rawPnl} | fee: ${platformFee} (${(PLATFORM_FEE_PCT * 100).toFixed(0)}%) | ` +
            `user P&L: ${userPnl} ${trade.currency}`
          );

          if (bot) {
            const emoji  = userPnl > 0 ? "✅" : userPnl === 0 ? "⚪" : "❌";
            const result = userPnl > 0 ? "Won" : userPnl === 0 ? "Neutral" : "Lost";

            await bot.sendMessage(
              chatId,
              `${emoji} *Trade Settled*\n\n` +
              `📋 ${trade.event_title}\n` +
              `📌 ${trade.side} ${trade.outcome_label || trade.outcome}\n` +
              `💰 ${trade.currency} ${trade.amount}\n\n` +
              `*Result:* ${result}\n` +
              `*P&L:* \`${userPnl >= 0 ? "+" : ""}${userPnl.toFixed(2)} ${trade.currency}\`\n` +
              (platformFee > 0 ? `*Platform fee:* \`${platformFee.toFixed(2)} ${trade.currency}\`\n` : "") +
              `\n_/pnl to see your full summary_`,
              { parse_mode: "Markdown" }
            );
          }
        }
      } catch (err) {
        console.error(`[Resolver] User ${chatId} failed:`, err.message);
      }
    }
  } catch (err) {
    console.error("[Resolver] Error:", err.message);
  }
}
