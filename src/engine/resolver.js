import { getPool, updateTrade, getOpenTrades } from "../db/database.js";
import { getEventById }     from "../bayse/client.js";
import { decrypt }          from "../utils/encryption.js";
import { sendTradeSettled } from "../bot/alerts.js";

let timer = null;

export function startResolver() {
  getPool().query(`
    UPDATE trades SET status='stale', resolved_at=NOW()
    WHERE status='open' AND executed_at < NOW() - INTERVAL '7 days'
  `).then(r => {
    if (r.rowCount > 0) console.log(`[Resolver] Marked ${r.rowCount} stale trades`);
  }).catch(() => {});

  timer = setInterval(resolve, 60 * 1000); // check every 1 min
  console.log("[Resolver] Started");
  setTimeout(resolve, 20_000);
}

export function stopResolver() {
  if (timer) clearInterval(timer);
}

async function resolve() {
  try {
    const trades = await getOpenTrades();
    if (!trades.length) return;

    for (const trade of trades) {
      try {
        const pubKey = decrypt(trade.bayse_pub_key)?.trim();
        const event  = await getEventById(pubKey, trade.event_id);
        if (!event) continue;

        const markets = event?.markets || [];
        const market  = markets.find(m => m.id === trade.market_id) || markets[0];
        if (!market) continue;

        const status  = (market.status || event.status || "").toLowerCase();
        const settled = ["resolved", "settled", "closed", "completed"].some(s => status.includes(s));
        if (!settled) continue;

        // Must have a winner to settle — don't guess
        const winnerId = market.winningOutcomeId || market.resolvedOutcomeId;
        if (!winnerId) {
          console.log(`[Resolver] Trade ${trade.id} — settled but no winner yet, skipping`);
          continue;
        }

        // Match our outcome to the winning outcome
        // Check both label match and direct outcomeId match
        const o1Wins = winnerId === market.outcome1Id;
        const o2Wins = winnerId === market.outcome2Id;

        // Determine which outcomeId user bought
        // We stored the outcomeId in bayse_order_id? No — we stored outcome label (YES/NO)
        // So match by label
        const o1Label = (market.outcome1Label || "").toUpperCase();
        const o2Label = (market.outcome2Label || "").toUpperCase();
        const userLabel = (trade.outcome_label || trade.outcome || "").toUpperCase();

        let won = null;
        if (o1Wins) {
          won = userLabel === o1Label ||
            (["YES","UP"].includes(userLabel) && ["YES","UP"].includes(o1Label));
        } else if (o2Wins) {
          won = userLabel === o2Label ||
            (["YES","UP"].includes(userLabel) && ["YES","UP"].includes(o2Label));
        }

        if (won === null) {
          console.log(`[Resolver] Trade ${trade.id} — cannot determine win/loss, skipping`);
          continue;
        }

        // P&L calculation
        // On Bayse CLOB: if you buy YES at price p with amount A
        // Win: you get back A / p (your stake + profit)
        // Profit = A * (1-p) / p
        // Loss: you lose your stake A
        const fillPrice = trade.fill_price || 0.5;
        const pnl = won
          ? parseFloat((trade.amount * (1 - fillPrice) / fillPrice).toFixed(2))
          : parseFloat((-trade.amount).toFixed(2));

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

        console.log(`[Resolver] Trade ${trade.id} | ${won ? "WON" : "LOST"} | pnl:${pnl}`);

      } catch (err) {
        console.error(`[Resolver] Trade ${trade.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error("[Resolver] Error:", err.message);
  }
}
