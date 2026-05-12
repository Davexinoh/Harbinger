import { getPool, updateTrade, getOpenTrades } from "../db/database.js";
import { getEventById }    from "../bayse/client.js";
import { decrypt }         from "../utils/encryption.js";
import { sendTradeSettled } from "../bot/alerts.js";

let timer = null;

export function startResolver() {
  getPool().query(`
    UPDATE trades SET status='stale', resolved_at=NOW()
    WHERE status='open' AND executed_at < NOW() - INTERVAL '7 days'
  `).then(r => {
    if (r.rowCount > 0) console.log(`[Resolver] Marked ${r.rowCount} stale trades`);
  }).catch(() => {});

  timer = setInterval(resolve, 2 * 60 * 1000);
  console.log("[Resolver] Started");
  setTimeout(resolve, 30_000);
}

export function stopResolver() {
  if (timer) clearInterval(timer);
}

async function resolve() {
  try {
    const trades = await getOpenTrades();
    if (!trades.length) return;

    console.log(`[Resolver] Checking ${trades.length} open trade(s)`);

    for (const trade of trades) {
      try {
        const pubKey = decrypt(trade.bayse_pub_key)?.trim();
        const event  = await getEventById(pubKey, trade.event_id);
        if (!event) continue;

        const markets = event?.markets || [];
        const market  = markets.find(m => m.id === trade.market_id) || markets[0];
        if (!market) continue;

        const status  = (market.status || event.status || "").toLowerCase();
        const settled = ["resolved","settled","closed","completed"].some(s => status.includes(s));
        if (!settled) continue;

        const winnerId = market.winningOutcomeId || market.resolvedOutcomeId;
        let pnl = 0;

        if (winnerId) {
          const userBoughtOutcome1 =
            (trade.outcome === "YES" && (market.outcome1Label || "").toUpperCase().includes("YES")) ||
            (trade.outcome === "NO"  && (market.outcome1Label || "").toUpperCase().includes("NO"));

          const userOutcomeId = userBoughtOutcome1 ? market.outcome1Id : market.outcome2Id;
          const won           = userOutcomeId === winnerId;
          const fillPrice     = trade.fill_price || 0.5;
          pnl = won
            ? parseFloat((trade.amount * (1 - fillPrice) / fillPrice).toFixed(2))
            : -trade.amount;
        }

        await updateTrade(trade.id, {
          status:      "resolved",
          pnl,
          resolved_at: new Date().toISOString(),
        });

        await sendTradeSettled(trade.chat_id, {
          title:   trade.event_title,
          outcome: trade.outcome_label || trade.outcome,
          amount:  trade.amount,
          pnl,
        });

        console.log(`[Resolver] Trade ${trade.id} settled | pnl:${pnl}`);

      } catch (err) {
        console.error(`[Resolver] Trade ${trade.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error("[Resolver] Error:", err.message);
  }
}
