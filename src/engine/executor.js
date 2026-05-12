import { placeOrder, resolveOutcomeId } from "../bayse/client.js";
import { decrypt }     from "../utils/encryption.js";
import { insertTrade } from "../db/database.js";

// Per-user+market dedup — prevents same user hitting same market twice concurrently
const inFlight = new Set();

export async function executeTrade(user, match, signals) {
  const pubKey = decrypt(user.bayse_pub_key)?.trim();
  const secKey = decrypt(user.bayse_sec_key)?.trim();
  if (!pubKey || !secKey) throw new Error("Missing keys");

  const { event, market } = match;

  // Key includes chat_id — different users can trade same market independently
  const dedupeKey = `${user.chat_id}:${event.id}:${market.id}`;
  if (inFlight.has(dedupeKey)) throw new Error("Already in flight");
  inFlight.add(dedupeKey);

  try {
    const leader    = [signals.crypto, signals.btc15m]
      .filter(s => s?.score != null)
      .sort((a, b) => b.score - a.score)[0];
    const direction = leader?.direction === "UP" ? "YES" : "NO";

    const { outcomeId, outcomeLabel } = resolveOutcomeId(market, direction);
    if (!outcomeId) throw new Error(`Cannot resolve outcomeId for ${direction}`);

    const threshold = parseFloat(user.threshold)        || 0.6;
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

    console.log(`[Executor] ${user.chat_id} → "${event.title.slice(0, 40)}" | ${direction} | outcomeId:${outcomeId} | ₦${amount}`);

    const result = await placeOrder(pubKey, secKey, event.id, market.id, orderBody);

    await insertTrade({
      chat_id:        String(user.chat_id),
      event_id:       event.id,
      market_id:      market.id,
      event_title:    event.title,
      outcome_label:  outcomeLabel || direction,
      signal_source:  leader?.label || "composite",
      side:           "BUY",
      outcome:        direction,
      amount,
      fill_price:     result?.order?.price || market.outcome1Price || null,
      bayse_order_id: result?.order?.id    || null,
    });

    return { result, amount, direction, outcomeLabel: outcomeLabel || direction };

  } finally {
    inFlight.delete(dedupeKey);
  }
}
