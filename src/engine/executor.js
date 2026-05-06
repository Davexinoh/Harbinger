import { placeOrder, resolveOutcomeId } from "../bayse/client.js";
import { decrypt } from "../utils/encryption.js";
import { insertTrade } from "../db/database.js";

const inFlight = new Set(); // per event+market dedup

export async function executeTrade(user, match, signals) {
  const pubKey = decrypt(user.bayse_pub_key);
  const secKey = decrypt(user.bayse_sec_key);
  if (!pubKey || !secKey) throw new Error("Missing decrypted keys");

  const { event, market } = match;
  const dedupeKey = `${event.id}:${market.id}`;
  if (inFlight.has(dedupeKey)) throw new Error("Already in flight");
  inFlight.add(dedupeKey);

  try {
    // Determine direction from highest-scoring signal
    const scores  = [signals.crypto, signals.btc15m].filter(s => s?.score != null);
    const leader  = scores.sort((a, b) => b.score - a.score)[0];
    const direction = (leader?.direction === "UP") ? "YES" : "NO";

    const { outcomeId, outcomeLabel } = resolveOutcomeId(market, direction);
    if (!outcomeId) throw new Error(`Cannot resolve outcomeId for direction ${direction}`);

    const threshold = parseFloat(user.threshold) || 0.6;
    const max       = parseFloat(user.max_trade_amount) || 200;
    const scale     = Math.min((signals.composite - threshold) / (1 - threshold), 1);
    // Always at least ₦100, scale up based on signal strength
    const amount    = Math.max(Math.round(max * (0.5 + 0.5 * scale)), 100);

    const orderBody = {
      side:      "BUY",
      outcomeId: String(outcomeId),
      amount,
      type:      "MARKET",
      currency:  "NGN",
    };

    console.log(`[Executor] ${user.chat_id} → ${event.title.slice(0, 40)} | ${direction} | ₦${amount} | outcomeId:${outcomeId}`);

    const result = await placeOrder(pubKey, secKey, event.id, market.id, orderBody);
    const order  = result?.order;

    await insertTrade({
      chat_id:        String(user.chat_id),
      event_id:       event.id,
      market_id:      market.id,
      event_title:    event.title,
      outcome_label:  outcomeLabel,
      signal_source:  leader?.label || "composite",
      side:           "BUY",
      outcome:        direction,
      amount,
      fill_price:     order?.price || market.outcome1Price || null,
      bayse_order_id: order?.id    || null,
    });

    return { order, amount, direction, outcomeLabel };

  } finally {
    inFlight.delete(dedupeKey);
  }
}
