import crypto from "crypto";
import fetch  from "node-fetch";

const BASE_URL = "https://relay.bayse.markets";

// ─── HMAC signed request ──────────────────────────────────────────────────────

export async function signedRequest(publicKey, secretKey, method, path, body = null) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyStr   = body ? JSON.stringify(body) : "";
  const bodyHash  = crypto.createHash("sha256").update(bodyStr).digest("hex");
  const payload   = `${timestamp}.${method}.${path}.${bodyHash}`;
  const signature = crypto.createHmac("sha256", secretKey).update(payload).digest("base64");

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "X-Public-Key": publicKey,
      "X-Timestamp":  timestamp,
      "X-Signature":  signature,
      "Content-Type": "application/json",
    },
    body: bodyStr || undefined,
  });

  if (!res.ok) throw new Error(`Bayse ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Read request ─────────────────────────────────────────────────────────────

export async function readRequest(publicKey, path) {
  const headers = publicKey ? { "X-Public-Key": publicKey } : {};
  const res     = await fetch(`${BASE_URL}${path}`, { headers });
  if (!res.ok) throw new Error(`Bayse ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Events ───────────────────────────────────────────────────────────────────

export async function getEvents(publicKey, params = {}) {
  const q = new URLSearchParams();
  q.set("status", params.status || "open");
  q.set("page",   params.page   || 1);
  q.set("size",   params.size   || 50);
  if (params.category) q.set("category", params.category);
  if (params.keyword)  q.set("keyword",  params.keyword);
  const data = await readRequest(publicKey, `/v1/pm/events?${q.toString()}`);
  return data?.events || [];
}

export async function getEventById(publicKey, eventId) {
  return readRequest(publicKey, `/v1/pm/events/${eventId}`);
}

// ─── Quote ────────────────────────────────────────────────────────────────────

export async function getQuote(publicKey, eventId, marketId, outcomeId, side, amount, currency = "USD") {
  const headers = { "Content-Type": "application/json", ...(publicKey ? { "X-Public-Key": publicKey } : {}) };
  const res = await fetch(`${BASE_URL}/v1/pm/events/${eventId}/markets/${marketId}/quote`, {
    method: "POST", headers,
    body:   JSON.stringify({ side, outcomeId, amount, currency }),
  });
  if (!res.ok) throw new Error(`Bayse quote ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Orders ───────────────────────────────────────────────────────────────────

export async function placeOrder(publicKey, secretKey, eventId, marketId, orderBody) {
  return signedRequest(
    publicKey,
    secretKey,
    "POST",
    `/v1/pm/events/${eventId}/markets/${marketId}/orders`,
    orderBody
  );
}

export async function cancelOrder(publicKey, secretKey, eventId, marketId, orderId) {
  return signedRequest(publicKey, secretKey, "DELETE", `/v1/pm/events/${eventId}/markets/${marketId}/orders/${orderId}`);
}

export async function getOpenOrders(publicKey, secretKey, eventId, marketId) {
  return signedRequest(publicKey, secretKey, "GET", `/v1/pm/events/${eventId}/markets/${marketId}/orders`);
}

// ─── Portfolio & wallet ───────────────────────────────────────────────────────

export async function getPortfolio(publicKey, secretKey) {
  return signedRequest(publicKey, secretKey, "GET", "/v1/pm/portfolio");
}

export async function getWalletAssets(publicKey, secretKey) {
  return signedRequest(publicKey, secretKey, "GET", "/v1/wallet/assets");
}

export async function getLiquidityRewards(publicKey, secretKey) {
  return signedRequest(publicKey, secretKey, "GET", "/v1/pm/liquidity-rewards/active");
}

// ─── Validate keys ────────────────────────────────────────────────────────────

export async function validateKeys(publicKey, secretKey) {
  try {
    await getPortfolio(publicKey, secretKey);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

// ─── resolveOutcomeId ─────────────────────────────────────────────────────────
// Handles ALL Bayse market shapes:
// - YES/NO markets (standard)
// - Up/Down markets (BTC 15m)
// - Custom label markets (elections etc)
// - outcomes[] array shape
// Returns { outcomeId, outcomeLabel }

export function resolveOutcomeId(market, suggestedOutcome) {
  const target = suggestedOutcome.toUpperCase();

  // Shape 1: outcomes[] array
  if (Array.isArray(market.outcomes) && market.outcomes.length >= 2) {
    const bullish = ["YES", "UP", "OVER", "WIN", "TRUE"];
    const bearish  = ["NO", "DOWN", "UNDER", "LOSS", "FALSE"];

    for (const o of market.outcomes) {
      const label = (o.label || o.name || o.title || "").toUpperCase();
      if (bullish.includes(target) && (bullish.includes(label) || bullish.some(b => label.includes(b)))) {
        return { outcomeId: o.id || o.outcomeId, outcomeLabel: o.label || o.name || target };
      }
      if (bearish.includes(target) && (bearish.includes(label) || bearish.some(b => label.includes(b)))) {
        return { outcomeId: o.id || o.outcomeId, outcomeLabel: o.label || o.name || target };
      }
    }
    // Fallback: YES/UP → first, NO/DOWN → second
    const idx = ["YES", "UP"].includes(target) ? 0 : 1;
    const o   = market.outcomes[idx];
    return { outcomeId: o.id || o.outcomeId, outcomeLabel: o.label || o.name || target };
  }

  // Shape 2: outcome1Id/outcome2Id fields
  const o1Label = (market.outcome1Label || market.option1Label || "").toUpperCase();
  const o2Label = (market.outcome2Label || market.option2Label || "").toUpperCase();
  const o1Id    = market.outcome1Id || market.option1Id;
  const o2Id    = market.outcome2Id || market.option2Id;

  const bullishLabels = ["YES", "UP", "OVER", "WIN"];
  const bearishLabels = ["NO", "DOWN", "UNDER", "LOSS"];
  const isBullishTarget = ["YES", "UP"].includes(target);

  if (isBullishTarget && (bullishLabels.some(l => o1Label.includes(l)) || o1Label === target)) {
    return { outcomeId: o1Id, outcomeLabel: market.outcome1Label || market.option1Label || target };
  }
  if (!isBullishTarget && (bearishLabels.some(l => o1Label.includes(l)) || o1Label === target)) {
    return { outcomeId: o1Id, outcomeLabel: market.outcome1Label || market.option1Label || target };
  }
  if (isBullishTarget && (bullishLabels.some(l => o2Label.includes(l)) || o2Label === target)) {
    return { outcomeId: o2Id, outcomeLabel: market.outcome2Label || market.option2Label || target };
  }
  if (!isBullishTarget && (bearishLabels.some(l => o2Label.includes(l)) || o2Label === target)) {
    return { outcomeId: o2Id, outcomeLabel: market.outcome2Label || market.option2Label || target };
  }

  // No label match — positional fallback
  if (isBullishTarget) {
    return { outcomeId: o1Id, outcomeLabel: market.outcome1Label || market.option1Label || "YES" };
  }
  return { outcomeId: o2Id, outcomeLabel: market.outcome2Label || market.option2Label || "NO" };
}
