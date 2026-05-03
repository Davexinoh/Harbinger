import { getQuote, placeOrder, resolveOutcomeId } from "../bayse/client.js";
import { insertTrade } from "../db/database.js";
import { decrypt } from "../utils/encryption.js";

export async function executeTrade(user, match, decision) {
  const publicKey = decrypt(user.bayse_pub_key);
  const secretKey = decrypt(user.bayse_sec_key);
  if (!publicKey || !secretKey) throw new Error("Missing Bayse API keys");

  const { event, market, suggestedOutcome, signalSource, signalScore } = match;
  const currency = user.currency || "USD";
  const side     = "BUY";

  const rawAmount  = decision.amount;
  const safeAmount = currency === "NGN"
    ? Math.max(Math.round(rawAmount), 100)
    : Math.max(parseFloat(rawAmount.toFixed(2)), 1);

  // Resolve outcomeId — guard against null
  const resolved = resolveOutcomeId(market, suggestedOutcome);

  if (!resolved || !resolved.outcomeId) {
    // Log market structure to help debug
    console.error(`[Executor] Cannot resolve outcomeId for ${suggestedOutcome}. Market:`, JSON.stringify({
      outcome1Id:    market.outcome1Id,
      outcome1Label: market.outcome1Label,
      outcome2Id:    market.outcome2Id,
      outcome2Label: market.outcome2Label,
    }));
    throw new Error(`outcomeId is null for ${suggestedOutcome} — market may have unexpected structure`);
  }

  console.log(
    `[Executor] ➜ "${event.title}" | BUY ${resolved.outcomeLabel} (${resolved.outcomeId}) | ` +
    `${currency} ${safeAmount} | ${signalSource} ${(signalScore * 100).toFixed(0)}%`
  );

  // Quote
  const quote = await getQuote(
    publicKey, event.id, market.id, resolved.outcomeId, side, safeAmount, currency
  );

  const price = quote.price || quote.expectedPrice;
  if (!price || price < 0.03 || price > 0.97) {
    throw new Error(`Market price ${price} at extreme — skipping`);
  }

  // Order
  const order = await placeOrder(publicKey, secretKey, event.id, market.id, {
    side,
    outcomeId: resolved.outcomeId,
    amount:    safeAmount,
    type:      "MARKET",
    currency,
  });

  const tradeRecord = {
    chat_id:        String(user.chat_id),
    event_id:       event.id,
    market_id:      market.id,
    event_title:    event.title || "Unknown Event",
    outcome_label:  resolved.outcomeLabel,
    signal_source:  signalSource,
    confidence:     signalScore,
    side,
    outcome:        suggestedOutcome,
    amount:         safeAmount,
    currency,
    expected_price: price,
    status:         "open",
  };

  const result = await insertTrade(tradeRecord);
  return { tradeId: result.id, order, quote, tradeRecord, outcomeLabel: resolved.outcomeLabel };
}
