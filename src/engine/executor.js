import { placeOrder, resolveOutcomeId } from "../bayse/client.js";
import { insertTrade } from "../db/database.js";
import { decrypt } from "../utils/encryption.js";

const ACTIVE_TRADES = new Set();

function tradeKey(eventId, marketId, outcomeId) {
  return `${eventId}:${marketId}:${outcomeId}`;
}

export async function executeTrade(user, match, decision) {
  const publicKey = decrypt(user.bayse_pub_key);
  const secretKey = decrypt(user.bayse_sec_key);

  if (!publicKey || !secretKey) throw new Error("Missing API keys");

  const { event, market, suggestedOutcome, signalSource, signalScore } = match;
  const currency = user.currency || "USD";
  const side     = "BUY";

  const rawAmount = Number(decision.amount);
  if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
    throw new Error(`Invalid trade amount: ${decision.amount}`);
  }

  const resolved  = resolveOutcomeId(market, suggestedOutcome);
  const outcomeId = resolved?.outcomeId != null ? String(resolved.outcomeId) : null;
  if (!outcomeId) throw new Error(`Could not resolve outcomeId for: ${suggestedOutcome}`);

  const key = tradeKey(event.id, market.id, outcomeId);
  if (ACTIVE_TRADES.has(key)) throw new Error("Duplicate trade blocked");
  ACTIVE_TRADES.add(key);

  try {
    const maxCap = Number.isFinite(Number(user.max_trade_amount))
      ? Number(user.max_trade_amount)
      : currency === "NGN" ? 500 : 5;

    // Enforce minimums — NGN min is 100, USD min is 1
    const amount = currency === "NGN"
      ? Math.max(Math.min(Math.round(rawAmount), maxCap), 100)
      : Math.max(Math.min(Number(rawAmount.toFixed(2)), maxCap), 1);

    console.log(`[Executor] ${user.chat_id} | event:${event.id} | market:${market.id} | engine:${event.engine} | outcomeId:${outcomeId} | amount:${amount} | currency:${currency}`);

    const orderPayload = { side, outcomeId, amount, type: "MARKET", currency };

    const order = await placeOrder(publicKey, secretKey, event.id, market.id, orderPayload);

    const tradeRecord = {
      chat_id:        String(user.chat_id),
      event_id:       event.id,
      market_id:      market.id,
      event_title:    event.title || "Unknown",
      outcome_label:  resolved.outcomeLabel || suggestedOutcome,
      signal_source:  signalSource,
      confidence:     signalScore,
      side,
      outcome:        suggestedOutcome,
      amount,
      currency,
      expected_price: market.outcome1Price || 0.5,
      status:         "open",
    };

    const result = await insertTrade(tradeRecord);
    return { tradeId: result.id, order, tradeRecord };

  } finally {
    ACTIVE_TRADES.delete(key);
  }
}
