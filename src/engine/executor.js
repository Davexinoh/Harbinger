import { getQuote, placeOrder } from "../bayse/client.js";
import { insertTrade } from "../db/database.js";
import { decrypt } from "../utils/encryption.js";

export async function executeTrade(user, match, decision) {
  const publicKey = decrypt(user.bayse_pub_key);
  const secretKey = decrypt(user.bayse_sec_key);

  if (!publicKey || !secretKey) {
    throw new Error("Missing or invalid Bayse API keys");
  }

  const { event, market, suggestedOutcome, signalSource, signalScore } = match;
  const { amount } = decision;
  const currency = user.currency || "USD";
  const side = "BUY";

  // Step 1: Get a quote first — never trade blind
  let quote;
  try {
    quote = await getQuote(
      publicKey,
      event.id,
      market.id,
      side,
      suggestedOutcome,
      amount,
      currency
    );
  } catch (err) {
    throw new Error(`Quote failed: ${err.message}`);
  }

  // Sanity check — don't trade if price looks wrong
  if (quote.expectedPrice < 0.05 || quote.expectedPrice > 0.95) {
    throw new Error(
      `Market price ${quote.expectedPrice} is at an extreme — skipping to avoid bad fill`
    );
  }

  // Step 2: Place the order
  const orderBody = {
    side,
    outcome: suggestedOutcome,
    amount,
    currency,
  };

  const order = await placeOrder(publicKey, secretKey, event.id, market.id, orderBody);

  // Step 3: Log to DB
  const tradeRecord = {
    chat_id: user.chat_id,
    event_id: event.id,
    market_id: market.id,
    event_title: event.title || "Unknown Event",
    signal_source: signalSource,
    confidence: signalScore,
    side,
    outcome: suggestedOutcome,
    amount,
    currency,
    expected_price: quote.expectedPrice,
    status: "open",
  };

  const result = insertTrade(tradeRecord);

  return {
    tradeId: result.lastInsertRowid,
    order,
    quote,
    tradeRecord,
  };
    }
