import { getPool, updateTrade, getOpenTrades } from "../db/database.js";
import { readRequest } from "../bayse/client.js";
import { decrypt }     from "../utils/encryption.js";
import { sendAlert }   from "../bot/alerts.js";

let timer = null;

export function startResolver() {
  // Clean up zombie trades older than 7 days on boot
  getPool().query(`
    UPDATE trades SET status='stale', resolved_at=NOW()
    WHERE status='open' AND executed_at < NOW() - INTERVAL '7 days'
  `).then(r => {
    if (r.rowCount > 0) console.log(`[Resolver] Marked ${r.rowCount} stale trades`);
  }).catch(() => {});

  timer = setInterval(resolve, 2 * 60 * 1000);
  console.log("[Resolver] Started");
}

async function resolve() {
  try {
    const trades = await getOpenTrades();
    if (!trades.length) return;

    for (const trade of trades) {
      try {
        const pubKey = decrypt(trade.bayse_pub_key);
        const event  = await readRequest(pubKey, `/v1/pm/events/${trade.event_id}`);

        const markets = event?.markets || [];
        const market  = markets.find(m => m.id === trade.market_id) || markets[0];
        if (!market) continue;

        const status = (market.status || event.status || "").toLowerCase();
        const settled = ["resolved", "settled", "closed", "completed"].some(s => status.includes(s));
        if (!settled) continue;

        // Determine win/loss from winningOutcomeId
        const winnerId = market.winningOutcomeId || market.resolvedOutcomeId;
        let pnl = 0;

        if (winnerId) {
          // Figure out which outcome the user bought
          const userBoughtOutcome1 =
            (trade.outcome === "YES" && (market.outcome1Label || "").toUpperCase().includes("YES")) ||
            (trade.outcome === "NO"  && (market.outcome1Label || "").toUpperCase().includes("NO"));

          const userOutcomeId = userBoughtOutcome1 ? market.outcome1Id : market.outcome2Id;
          const won = userOutcomeId === winnerId;
          const fillPrice = trade.fill_price || 0.5;
          pnl = won
            ? parseFloat((trade.amount * (1 - fillPrice) / fillPrice).toFixed(2))
            : -trade.amount;
        }

        await updateTrade(trade.id, { status: "resolved", pnl, resolved_at: new Date().toISOString() });

        const icon = pnl > 0 ? "✅" : "❌";
        await sendAlert(trade.chat_id,
          `${icon} Trade Settled\n\n` +
          `${trade.event_title}\n` +
          `${trade.outcome} | ₦${trade.amount}\n` +
          `P&L: ${pnl > 0 ? "+" : ""}${pnl.toFixed(2)} NGN\n\n` +
          `/pnl for full summary`
        );

        console.log(`[Resolver] Trade ${trade.id} settled | pnl:${pnl}`);
      } catch (err) {
        console.error(`[Resolver] Trade ${trade.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error("[Resolver] Error:", err.message);
  }
}
