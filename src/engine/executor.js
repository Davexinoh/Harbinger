import { placeOrder, resolveOutcomeId } from "../bayse/client.js";
import { decrypt }     from "../utils/encryption.js";
import { insertTrade } from "../db/database.js";

const inFlight = new Set();

export async function executeTrade(user, match, signals) {
  const pubKey = decrypt(user.bayse_pub_key)?.trim();
  const secKey = decrypt(user.bayse_sec_key)?.trim();
  if (!pubKey || !secKey) throw new Error("Missing keys");

  const { event, market } = match;
  const dedupeKey = `${user.chat_id}:${event.id}:${market.id}`;
  if (inFlight.has(dedupeKey)) throw new Error("Already in flight");
  inFlight.add(dedupeKey);

  try {
    // Use direction from scorer edge analysis — not raw signal direction
    // Scorer picks which side has real edge based on market price
    const direction = match.direction || (signals.direction === "UP" ? "YES" : "NO");

    const { outcomeId, outcomeLabel } = resolveOutcomeId(market, direction);
    if (!outcomeId) throw new Error(`Cannot resolve outcomeId for ${direction}`);

    const threshold = parseFloat(user.threshold)        || 0.5;
    const max       = parseFloat(user.max_trade_amount) || 200;
    const scale     = Math.max(0, Math.min((signals.composite - threshold) / (1 - threshold), 1));
    const amount    = Math.max(Math.round(max * (0.5 + 0.5 * scale)), 100);

    const orderBody = {
      side:      "BUY",
      outcomeId: String(outcomeId),
      amount,
      type:      "MARKET",
      currency:  "NGN",
    };

    console.log(
      `[Executor] ${user.chat_id} → "${event.title.slice(0, 40)}" | ` +
      `${direction} | outcomeId:${outcomeId} | ₦${amount}`
    );

    const result = await placeOrder(pubKey, secKey, event.id, market.id, orderBody);

    // Get fill price from order response
    const fillPrice = result?.price
      || result?.order?.price
      || result?.averagePrice
      || (direction === "YES" ? market.outcome1Price : market.outcome2Price)
      || 0.5;

    await insertTrade({
      chat_id:        String(user.chat_id),
      event_id:       event.id,
      market_id:      market.id,
      event_title:    event.title,
      outcome_label:  outcomeLabel || direction,
      signal_source:  signals.btc15m?.label || "composite",
      side:           "BUY",
      outcome:        direction,
      amount,
      fill_price:     parseFloat(fillPrice) || 0.5,
      bayse_order_id: result?.id || result?.order?.id || null,
    });

    return { result, amount, direction, outcomeLabel: outcomeLabel || direction };

  } finally {
    inFlight.delete(dedupeKey);
  }
}
