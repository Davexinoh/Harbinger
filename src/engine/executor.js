import { placeOrder } from "../bayse/client.js";
import { decrypt }    from "../utils/encryption.js";
import { insertTrade } from "../db/database.js";

const inFlight = new Set();

export async function executeTrade(user, match, signals) {
  const pubKey = decrypt(user.bayse_pub_key)?.trim();
  const secKey = decrypt(user.bayse_sec_key)?.trim();
  if (!pubKey || !secKey) throw new Error("Missing keys");

  const { event, market } = match;
  const dedupeKey = `${event.id}:${market.id}`;
  if (inFlight.has(dedupeKey)) throw new Error("Already in flight");
  inFlight.add(dedupeKey);

  try {
    // Direction from leading signal
    const leader    = [signals.crypto, signals.btc15m]
      .filter(s => s?.score != null)
      .sort((a, b) => b.score - a.score)[0];
    const outcome   = leader?.direction === "UP" ? "YES" : "NO";

    const threshold = parseFloat(user.threshold) || 0.6;
    const max       = parseFloat(user.max_trade_amount) || 200;
    const scale     = Math.min((signals.composite - threshold) / (1 - threshold), 1);
    const amount    = Math.max(Math.round(max * (0.5 + 0.5 * scale)), 100);

    // Docs body: side, outcome ("YES"/"NO"), amount, currency
    // NO outcomeId, NO type field
    const orderBody = {
      side:     "BUY",
      outcome,
      amount,
      currency: "NGN",
    };

    console.log(`[Executor] ${user.chat_id} → "${event.title.slice(0, 40)}" | ${outcome} | ₦${amount}`);

    const result = await placeOrder(pubKey, secKey, event.id, market.id, orderBody);

    await insertTrade({
      chat_id:       String(user.chat_id),
      event_id:      event.id,
      market_id:     market.id,
      event_title:   event.title,
      outcome_label: outcome,
      signal_source: leader?.label || "composite",
      side:          "BUY",
      outcome,
      amount,
      fill_price:    result?.order?.price || market.outcome1Price || null,
      bayse_order_id: result?.order?.id   || null,
    });

    return { result, amount, outcome };

  } finally {
    inFlight.delete(dedupeKey);
  }
}
