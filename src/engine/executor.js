import { getQuote, placeOrder, resolveOutcomeId } from "../bayse/client.js";
import { insertTrade } from "../db/database.js";
import { decrypt } from "../utils/encryption.js";

const ACTIVE_TRADES = new Set(); // idempotency guard

function tradeKey(eventId, marketId, outcomeId) {
  return `${eventId}:${marketId}:${outcomeId}`;
}

export async function executeTrade(user, match, decision) {
  const publicKey = decrypt(user.bayse_pub_key);
  const secretKey = decrypt(user.bayse_sec_key);

  if (!publicKey || !secretKey) {
    throw new Error("Missing API keys");
  }

  const { event, market, suggestedOutcome, signalSource, signalScore } = match;

  const currency = user.currency || "USD";
  const side     = "BUY";

  // Validate and floor amount
  const rawAmount = Number(decision.amount);
  if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
    throw new Error(`Invalid trade amount: ${decision.amount}`);
  }

  // Resolve outcome — force to string regardless of what the market returns
  const resolved = resolveOutcomeId(market, suggestedOutcome);
  const outcomeId = resolved?.outcomeId != null ? String(resolved.outcomeId) : null;

  if (!outcomeId) {
    throw new Error(`Could not resolve outcomeId for outcome: ${suggestedOutcome}`);
  }

  const key = tradeKey(event.id, market.id, outcomeId);
  if (ACTIVE_TRADES.has(key)) {
    throw new Error("Duplicate trade blocked");
  }
  ACTIVE_TRADES.add(key);

  try {
    const maxCap = Number.isFinite(Number(user.max_trade_amount))
      ? Number(user.max_trade_amount)
      : currency === "NGN" ? 500 : 5;

    const amount = Math.min(
      currency === "NGN"
        ? Math.max(Math.round(rawAmount), 100)
        : Math.max(Number(rawAmount.toFixed(2)), 1),
      maxCap
    );

    // Pre-flight log — shows exactly what we're sending to Bayse
    console.log(`[Executor] ${user.chat_id} | event:${event.id} market:${market.id}`, {
      side, outcomeId, amount, type: "MARKET", currency,
    });

    const quote = await getQuote(
      publicKey,
      event.id,
      market.id,
      outcomeId,
      side,
      amount,
      currency
    );

    const price = quote?.price ?? quote?.expectedPrice;
    if (!Number.isFinite(price)) {
      throw new Error("Invalid quote price");
    }

    if (price < 0.03 || price > 0.97) {
      throw new Error(`Unsafe market price: ${price}`);
    }

    const orderPayload = {
      side,
      outcomeId,
      amount,
      type:     "MARKET",
      currency,
    };

    const order = await placeOrder(
      publicKey,
      secretKey,
      event.id,
      market.id,
      orderPayload
    );

    const tradeRecord = {
      chat_id:        String(user.chat_id),
      event_id:       event.id,
      market_id:      market.id,
      event_title:    event.title || "Unknown",
      signal_source:  signalSource,
      confidence:     signalScore,
      side,
      outcome:        suggestedOutcome,
      amount,
      currency,
      expected_price: price,
      status:         "open",
      created_at:     new Date().toISOString(),
    };

    const result = await insertTrade(tradeRecord);

    return {
      tradeId: result.lastInsertRowid,
      order,
      quote,
      tradeRecord,
    };

  } finally {
    ACTIVE_TRADES.delete(key);
  }
}
