import { getQuote, placeOrder, resolveOutcomeId } from "../bayse/client.js";
import { insertTrade } from "../db/database.js";
import { decrypt } from "../utils/encryption.js";

export async function executeTrade(user, match, decision) {
  const publicKey = decrypt(user.bayse_pub_key);
  const secretKey = decrypt(user.bayse_sec_key);
  if (!publicKey || !secretKey) throw new Error("Missing Bayse API keys");

  const { event, market, suggestedOutcome, signalSource, signalScore } = match;
  const { amount } = decision;
  const currency   = user.currency || "USD";
  const side       = "BUY";

  // Resolve outcomeId UUID from label (YES/NO)
  const outcomeId = resolveOutcomeId(market, suggestedOutcome);
  if (!outcomeId) throw new Error(`Cannot resolve outcomeId for ${suggestedOutcome}`);

  // Step 1: Get quote (POST)
  const quote = await getQuote(publicKey, event.id, market.id, outcomeId, side, amount, currency);

  // Sanity check — don't trade at extreme prices
  if (quote.price < 0.05 || quote.price > 0.95) {
    throw new Error(`Market price ${quote.price} at extreme — skipping`);
  }

  // Step 2: Place order
  const order = await placeOrder(publicKey, secretKey, event.id, market.id, {
    side,
    outcomeId,
    amount,
    currency,
  });

  // Step 3: Log
  const tradeRecord = {
    chat_id:        String(user.chat_id),
    event_id:       event.id,
    market_id:      market.id,
    event_title:    event.title || "Unknown Event",
    signal_source:  signalSource,
    confidence:     signalScore,
    side,
    outcome:        suggestedOutcome,
    amount,
    currency,
    expected_price: quote.price,
    status:         "open",
  };

  const result = insertTrade(tradeRecord);

  return { tradeId: result.lastInsertRowid, order, quote, tradeRecord };
}
