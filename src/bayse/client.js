import crypto from "crypto";
import fetch  from "node-fetch";

const BASE = "https://relay.bayse.markets";

// ─── HMAC signed request (Write auth) ────────────────────────────────────────
export async function signedRequest(pubKey, secKey, method, path, body = null) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyStr   = body ? JSON.stringify(body) : "";
  // KEY FIX: no body = empty string in payload, not hash of empty string
  const bodyHash  = body
    ? crypto.createHash("sha256").update(bodyStr).digest("hex")
    : "";
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

// ─── Read request (X-Public-Key only) ────────────────────────────────────────
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
// Required: side, outcomeId, amount, type, currency
// NGN minimum: ₦100
export async function placeOrder(pubKey, secKey, eventId, marketId, body) {
  const path = `/v1/pm/events/${eventId}/markets/${marketId}/orders`;
  return signedRequest(pubKey, secKey, "POST", path, body);
}

// ─── Portfolio (Read auth only) ───────────────────────────────────────────────
export async function getPortfolio(pubKey) {
  return readRequest(pubKey, "/v1/pm/portfolio");
}

// ─── Validate keys ────────────────────────────────────────────────────────────
// Portfolio is Read auth — just X-Public-Key, no HMAC needed
export async function validateKeys(pubKey, secKey) {
  try {
    await readRequest(pubKey, "/v1/pm/portfolio");
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

// ─── Resolve outcomeId ────────────────────────────────────────────────────────
// Docs: market has outcome1Id, outcome1Label, outcome2Id, outcome2Label
export function resolveOutcomeId(market, direction) {
  const wantBull = direction.toUpperCase() === "YES" || direction.toUpperCase() === "UP";
  const bullish  = ["YES", "UP", "OVER", "WIN", "TRUE", "HIGHER"];
  const bearish  = ["NO",  "DOWN", "UNDER", "LOSS", "FALSE", "LOWER"];

  const label1 = (market.outcome1Label || "").toUpperCase();
  const label2 = (market.outcome2Label || "").toUpperCase();

  if (wantBull) {
    if (bullish.some(b => label1.includes(b)))
      return { outcomeId: market.outcome1Id, outcomeLabel: market.outcome1Label };
    if (bullish.some(b => label2.includes(b)))
      return { outcomeId: market.outcome2Id, outcomeLabel: market.outcome2Label };
    return { outcomeId: market.outcome1Id, outcomeLabel: market.outcome1Label || "YES" };
  } else {
    if (bearish.some(b => label1.includes(b)))
      return { outcomeId: market.outcome1Id, outcomeLabel: market.outcome1Label };
    if (bearish.some(b => label2.includes(b)))
      return { outcomeId: market.outcome2Id, outcomeLabel: market.outcome2Label };
    return { outcomeId: market.outcome2Id, outcomeLabel: market.outcome2Label || "NO" };
  }
}
