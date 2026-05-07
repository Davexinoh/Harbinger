import crypto from "crypto";
import fetch  from "node-fetch";

const BASE = "https://relay.bayse.markets";

export async function signedRequest(pubKey, secKey, method, path, body = null) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyStr   = body ? JSON.stringify(body) : "";
  const bodyHash  = bodyStr
    ? crypto.createHash("sha256").update(bodyStr, "utf8").digest("hex")
    : "";
  const payload   = `${timestamp}.${method}.${path}.${bodyHash}`;
  const signature = crypto.createHmac("sha256", secKey).update(payload, "utf8").digest("base64");

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

export async function readRequest(pubKey, path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "X-Public-Key": pubKey },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Bayse ${res.status}: ${text}`);
  return JSON.parse(text);
}

export async function getEvents(pubKey, { status = "open", category, size = 50, page = 1, currency = "NGN" } = {}) {
  const q = new URLSearchParams({ status, size, page, currency });
  if (category) q.set("category", category);
  const data = await readRequest(pubKey, `/v1/pm/events?${q}`);
  return data?.events || [];
}

export async function getEventById(pubKey, eventId) {
  return readRequest(pubKey, `/v1/pm/events/${eventId}`);
}

// Docs: body is { side, outcome, amount, currency }
// outcome is "YES" or "NO" — NOT a UUID, NOT outcomeId
export async function placeOrder(pubKey, secKey, eventId, marketId, body) {
  const path = `/v1/pm/events/${eventId}/markets/${marketId}/orders`;
  return signedRequest(pubKey, secKey, "POST", path, body);
}

export async function getPortfolio(pubKey) {
  return readRequest(pubKey, "/v1/pm/portfolio");
}

export async function validateKeys(pubKey) {
  try {
    await readRequest(pubKey, "/v1/pm/portfolio");
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}
