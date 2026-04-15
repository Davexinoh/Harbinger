import crypto from "crypto";
import fetch from "node-fetch";

const BASE_URL = "https://relay.bayse.markets";

// ─── HMAC-SHA256 signed request (write endpoints) ─────────────────────────────

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

// ─── Read request (X-Public-Key only) ────────────────────────────────────────

export async function readRequest(publicKey, path) {
  const headers = publicKey ? { "X-Public-Key": publicKey } : {};
  const res = await fetch(`${BASE_URL}${path}`, { headers });
  if (!res.ok) throw new Error(`Bayse ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── List events ──────────────────────────────────────────────────────────────
// Public endpoint — X-Public-Key optional (adds personalized data)
// Params: page, size, category, status, keyword, currency, trending

export async function getEvents(publicKey, params = {}) {
  const q = new URLSearchParams();
  q.set("status",   params.status   || "open");
  q.set("page",     params.page     || 1);
  q.set("size",     params.size     || 50);
  if (params.category) q.set("category", params.category);
  if (params.keyword)  q.set("keyword",  params.keyword);
  if (params.currency) q.set("currency", params.currency);

  const data = await readRequest(publicKey, `/v1/pm/events?${q.toString()}`);
  // Response shape: { events: [...], pagination: {...} }
  return data?.events || [];
}

// ─── Get quote — POST with body ───────────────────────────────────────────────
// outcomeId is the UUID from market.outcome1Id or market.outcome2Id
// Returns: { price, quantity, fee, amount, costOfShares, profitPercentage, ... }

export async function getQuote(publicKey, eventId, marketId, outcomeId, side, amount, currency = "USD") {
  const path = `/v1/pm/events/${eventId}/markets/${marketId}/quote`;
  const body = { side, outcomeId, amount, currency };

  // Quote is public — X-Public-Key optional for personalised profit estimates
  const headers = {
    "Content-Type": "application/json",
    ...(publicKey ? { "X-Public-Key": publicKey } : {}),
  };

  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Bayse quote ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Place order ──────────────────────────────────────────────────────────────
// outcomeId is UUID from market, side is BUY/SELL

export async function placeOrder(publicKey, secretKey, eventId, marketId, orderBody) {
  return signedRequest(publicKey, secretKey, "POST", `/v1/pm/events/${eventId}/markets/${marketId}/orders`, orderBody);
}

// ─── Portfolio (signed) ───────────────────────────────────────────────────────

export async function getPortfolio(publicKey, secretKey) {
  return signedRequest(publicKey, secretKey, "GET", "/v1/pm/portfolio");
}

// ─── Wallet assets (signed) — returns NGN/USD balances ───────────────────────

export async function getWalletAssets(publicKey, secretKey) {
  return signedRequest(publicKey, secretKey, "GET", "/v1/wallet/assets");
}

// ─── Liquidity rewards (signed) ───────────────────────────────────────────────

export async function getLiquidityRewards(publicKey, secretKey) {
  return signedRequest(publicKey, secretKey, "GET", "/v1/pm/liquidity-rewards/active");
}

// ─── Validate key pair ────────────────────────────────────────────────────────

export async function validateKeys(publicKey, secretKey) {
  try {
    await getPortfolio(publicKey, secretKey);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

// ─── Helper: get outcomeId from market + desired label ───────────────────────
// market has outcome1Id/outcome1Label and outcome2Id/outcome2Label
// suggestedOutcome is "YES" or "NO"

export function resolveOutcomeId(market, suggestedOutcome) {
  const label = suggestedOutcome.toUpperCase();
  if ((market.outcome1Label || "").toUpperCase() === label) return market.outcome1Id;
  if ((market.outcome2Label || "").toUpperCase() === label) return market.outcome2Id;
  // Fallback to outcome1
  return market.outcome1Id;
  }
      
