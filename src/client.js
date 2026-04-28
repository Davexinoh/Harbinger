import crypto from "crypto";
import fetch from "node-fetch";

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
  if (params.currency) q.set("currency", params.currency);

  const data = await readRequest(publicKey, `/v1/pm/events?${q.toString()}`);
  return data?.events || [];
}

// ─── Quote ────────────────────────────────────────────────────────────────────

export async function getQuote(publicKey, eventId, marketId, outcomeId, side, amount, currency = "USD") {
  const headers = {
    "Content-Type":  "application/json",
    ...(publicKey ? { "X-Public-Key": publicKey } : {}),
  };
  const res = await fetch(`${BASE_URL}/v1/pm/events/${eventId}/markets/${marketId}/quote`, {
    method: "POST",
    headers,
    body:   JSON.stringify({ side, outcomeId, amount, currency }),
  });
  if (!res.ok) throw new Error(`Bayse quote ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Orders ───────────────────────────────────────────────────────────────────

export async function placeOrder(publicKey, secretKey, eventId, marketId, orderBody) {
  return signedRequest(publicKey, secretKey, "POST", `/v1/pm/events/${eventId}/markets/${marketId}/orders`, orderBody);
}

// ─── Portfolio ────────────────────────────────────────────────────────────────

export async function getPortfolio(publicKey, secretKey) {
  return signedRequest(publicKey, secretKey, "GET", "/v1/pm/portfolio");
}

// ─── Wallet ───────────────────────────────────────────────────────────────────

export async function getWalletAssets(publicKey, secretKey) {
  return signedRequest(publicKey, secretKey, "GET", "/v1/wallet/assets");
}

// ─── Liquidity rewards ────────────────────────────────────────────────────────

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
// Maps YES/NO to the correct outcomeId and outcomeLabel from the market object
// Markets can have different label names — YES maps to outcome1 by label match
// Returns { outcomeId, outcomeLabel }

export function resolveOutcomeId(market, suggestedOutcome) {
  const target = suggestedOutcome.toUpperCase();

  // Try to match by label first — most reliable
  const outcome1Label = (market.outcome1Label || "").toUpperCase();
  const outcome2Label = (market.outcome2Label || "").toUpperCase();

  // Direct label match
  if (outcome1Label === target) {
    return { outcomeId: market.outcome1Id, outcomeLabel: market.outcome1Label };
  }
  if (outcome2Label === target) {
    return { outcomeId: market.outcome2Id, outcomeLabel: market.outcome2Label };
  }

  // YES maps to outcome1 by convention if no exact label match
  // NO maps to outcome2
  if (target === "YES") {
    return { outcomeId: market.outcome1Id, outcomeLabel: market.outcome1Label || "YES" };
  }
  if (target === "NO") {
    return { outcomeId: market.outcome2Id, outcomeLabel: market.outcome2Label || "NO" };
  }

  // Fallback
  return { outcomeId: market.outcome1Id, outcomeLabel: market.outcome1Label || suggestedOutcome };
}
