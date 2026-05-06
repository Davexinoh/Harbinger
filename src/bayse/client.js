import crypto from "crypto";
import fetch  from "node-fetch";

const BASE = "https://relay.bayse.markets";

// ─── HMAC signed request (Write auth) ────────────────────────────────────────
export async function signedRequest(pubKey, secKey, method, path, body = null) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyStr   = body ? JSON.stringify(body) : "";
  const bodyHash  = crypto.createHash("sha256").update(bodyStr).digest("hex");
  const payload   = `${timestamp}.${method}.${path}.${bodyHash}`;
  const signature = crypto.createHmac("sha256", secKey).update(payload).digest("base64");

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "X-Public-Key": pubKey,
      "X-Timestamp":  timestamp,
      "X-Signature":  signature,
      "Content-Type": "application/json",
    },
    body: bodyStr || undefined,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Bayse ${res.status}: ${text}`);
  return JSON.parse(text);
}

// ─── Read request (Read auth) ─────────────────────────────────────────────────
export async function readRequest(pubKey, path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "X-Public-Key": pubKey },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Bayse ${res.status}: ${text}`);
  return JSON.parse(text);
}

// ─── Events ───────────────────────────────────────────────────────────────────
export async function getEvents(pubKey, { status = "open", category, size = 50, page = 1, currency = "NGN" } = {}) {
  const q = new URLSearchParams({ status, size, page, currency });
  if (category) q.set("category", category);
  const data = await readRequest(pubKey, `/v1/pm/events?${q}`);
  return data?.events || [];
}

export async function getEventById(pubKey, eventId) {
  return readRequest(pubKey, `/v1/pm/events/${eventId}`);
}

// ─── Place order ──────────────────────────────────────────────────────────────
// Docs: POST /v1/pm/events/{eventId}/markets/{marketId}/orders
// Required body: side, outcomeId, amount, type, currency
// NGN minimum: ₦100
export async function placeOrder(pubKey, secKey, eventId, marketId, body) {
  const path = `/v1/pm/events/${eventId}/markets/${marketId}/orders`;
  return signedRequest(pubKey, secKey, "POST", path, body);
}

// ─── Portfolio ────────────────────────────────────────────────────────────────
// Read auth only — returns { outcomeBalances, portfolioCost, portfolioCurrentValue, ... }
export async function getPortfolio(pubKey) {
  return readRequest(pubKey, "/v1/pm/portfolio");
}

// ─── Validate keys ────────────────────────────────────────────────────────────
export async function validateKeys(pubKey, secKey) {
  try {
    // Use a signed GET to verify both keys work
    await signedRequest(pubKey, secKey, "GET", "/v1/pm/portfolio", null);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

// ─── Resolve outcomeId from market ───────────────────────────────────────────
// Docs confirm market has: outcome1Id, outcome1Label, outcome2Id, outcome2Label
// direction is "YES" or "NO"
export function resolveOutcomeId(market, direction) {
  const dir = direction.toUpperCase();

  // Normalise labels
  const label1 = (market.outcome1Label || "").toUpperCase();
  const label2 = (market.outcome2Label || "").toUpperCase();

  const bullish = ["YES", "UP", "OVER", "WIN", "TRUE", "HIGHER"];
  const bearish  = ["NO",  "DOWN", "UNDER", "LOSS", "FALSE", "LOWER"];

  const wantBull = dir === "YES" || dir === "UP";

  // Try label match first
  if (wantBull) {
    if (bullish.some(b => label1.includes(b))) return { outcomeId: market.outcome1Id, outcomeLabel: market.outcome1Label };
    if (bullish.some(b => label2.includes(b))) return { outcomeId: market.outcome2Id, outcomeLabel: market.outcome2Label };
    // Positional fallback
    return { outcomeId: market.outcome1Id, outcomeLabel: market.outcome1Label || "YES" };
  } else {
    if (bearish.some(b => label1.includes(b))) return { outcomeId: market.outcome1Id, outcomeLabel: market.outcome1Label };
    if (bearish.some(b => label2.includes(b))) return { outcomeId: market.outcome2Id, outcomeLabel: market.outcome2Label };
    return { outcomeId: market.outcome2Id, outcomeLabel: market.outcome2Label || "NO" };
  }
}
