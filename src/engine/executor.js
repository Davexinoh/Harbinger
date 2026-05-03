import { getQuote, placeOrder, resolveOutcomeId } from "../bayse/client.js";
import { insertTrade } from "../db/database.js";
import { decrypt } from "../utils/encryption.js";

export async function executeTrade(user, match, decision) {
  const publicKey = decrypt(user.bayse_pub_key);
  const secretKey = decrypt(user.bayse_sec_key);

  if (!publicKey || !secretKey) {
    throw new Error("Missing Bayse API keys");
  }

  const { event, market, suggestedOutcome, signalSource, signalScore } = match;
  const currency = user.currency || "USD";
  const side = "BUY";

  // ─── Amount validation ───────────────────────────────────────────────
  const rawAmount = Number(decision.amount);

  if (!rawAmount || isNaN(rawAmount)) {
    throw new Error(`Invalid amount: ${decision.amount}`);
  }

  const amount =
    currency === "NGN"
      ? Math.max(Math.round(rawAmount), 100) // minimum ₦100
      : Math.max(parseFloat(rawAmount.toFixed(2)), 1); // minimum $1

  // ─── Resolve outcomeId correctly (FIXED) ─────────────────────────────
  const { outcomeId } = resolveOutcomeId(market, suggestedOutcome);

  if (!outcomeId || typeof outcomeId !== "string") {
    throw new Error(
      `Invalid outcomeId resolved: ${JSON.stringify(outcomeId)}`
    );
  }

  console.log(
    `[Executor] Quoting: ${event.title} | ${side} ${suggestedOutcome} | ${currency} ${amount}`
  );

  // ─── Step 1: Get quote ───────────────────────────────────────────────
  const quote = await getQuote(
    publicKey,
    event.id,
    market.id,
    outcomeId,
    side,
    amount,
    currency
  );

  const price = quote.price || quote.expectedPrice;

  if (price == null) {
    throw new Error("Quote missing price");
  }

  // Avoid extreme prices
  if (price < 0.03 || price > 0.97) {
    throw new Error(`Market price ${price} at extreme — skipping`);
  }

  // ─── Step 2: Place order ─────────────────────────────────────────────
  const orderPayload = {
    side,
    outcomeId,
    amount,
    type: "MARKET",
    currency,
  };

  console.log("[EXECUTE ORDER]", {
    eventId: event.id,
    marketId: market.id,
    orderPayload,
  });

  const order = await placeOrder(
    publicKey,
    secretKey,
    event.id,
    market.id,
    orderPayload
  );

  // ─── Step 3: Log trade ───────────────────────────────────────────────
  const tradeRecord = {
    chat_id: String(user.chat_id),
    event_id: event.id,
    market_id: market.id,
    event_title: event.title || "Unknown Event",
    signal_source: signalSource,
    confidence: signalScore,
    side,
    outcome: suggestedOutcome,
    amount,
    currency,
    expected_price: price,
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
