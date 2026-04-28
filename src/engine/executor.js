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

  // NGN: whole numbers only, min ₦100. USD: min $1
  const rawAmount  = decision.amount;
  const safeAmount = currency === "NGN"
    ? Math.max(Math.round(rawAmount), 100)
    : Math.max(parseFloat(rawAmount.toFixed(2)), 1);

  // Resolve the actual outcome to bet on
  // suggestedOutcome is "YES" or "NO" — map to the correct outcome label and ID
  const resolved = resolveOutcomeId(market, suggestedOutcome);
  if (!resolved.outcomeId) throw new Error(`Cannot resolve outcomeId for ${suggestedOutcome}`);

  console.log(
    `[Executor] ${event.title} | BUY ${resolved.outcomeLabel} | ` +
    `${currency} ${safeAmount} | confidence: ${(signalScore * 100).toFixed(0)}%`
  );

  // Get quote
  const quote = await getQuote(
    publicKey, event.id, market.id, resolved.outcomeId, side, safeAmount, currency
  );

  const price = quote.price || quote.expectedPrice;
  if (!price || price < 0.03 || price > 0.97) {
    throw new Error(`Market price ${price} at extreme — skipping`);
  }

  // Place order
  const order = await placeOrder(publicKey, secretKey, event.id, market.id, {
    side,
    outcomeId: resolved.outcomeId,
    amount:    safeAmount,
    type:      "MARKET",
    currency,
  });

  // Log trade with outcome label for display
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
