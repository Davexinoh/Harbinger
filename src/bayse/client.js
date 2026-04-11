import crypto from "crypto";
import fetch from "node-fetch";

const BASE_URL = "https://relay.bayse.markets";

// ─── HMAC-SHA256 signed request ───────────────────────────────────────────────

export async function signedRequest(publicKey, secretKey, method, path, body = null) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyStr = body ? JSON.stringify(body) : "";
  const bodyHash = crypto.createHash("sha256").update(bodyStr).digest("hex");
  const payload = `${timestamp}.${method}.${path}.${bodyHash}`;
  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(payload)
    .digest("base64");

  const headers = {
    "X-Public-Key": publicKey,
    "X-Timestamp": timestamp,
    "X-Signature": signature,
    "Content-Type": "application/json",
  };

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: bodyStr || undefined,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Bayse API ${res.status}: ${err}`);
  }

  return res.json();
}

// ─── Read request (public key only) ──────────────────────────────────────────

export async function readRequest(publicKey, path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "X-Public-Key": publicKey },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Bayse API ${res.status}: ${err}`);
  }

  return res.json();
}

// ─── Public request (no auth) ─────────────────────────────────────────────────

export async function publicRequest(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Bayse API ${res.status}: ${err}`);
  }
  return res.json();
}

// ─── Market endpoints ─────────────────────────────────────────────────────────

export async function getEvents(category = null, status = "open", limit = 20) {
  let path = `/v1/pm/events?status=${status}&limit=${limit}`;
  if (category) path += `&category=${category}`;
  return publicRequest(path);
}

export async function getEventById(eventId) {
  return publicRequest(`/v1/pm/events/${eventId}`);
}

export async function getQuote(publicKey, eventId, marketId, side, outcome, amount, currency) {
  return readRequest(
    publicKey,
    `/v1/pm/events/${eventId}/markets/${marketId}/quote?side=${side}&outcome=${outcome}&amount=${amount}&currency=${currency}`
  );
}

// ─── Trading endpoints ────────────────────────────────────────────────────────

export async function placeOrder(publicKey, secretKey, eventId, marketId, orderBody) {
  const path = `/v1/pm/events/${eventId}/markets/${marketId}/orders`;
  return signedRequest(publicKey, secretKey, "POST", path, orderBody);
}

// ─── Portfolio endpoints ──────────────────────────────────────────────────────

export async function getPortfolio(publicKey, secretKey) {
  return signedRequest(publicKey, secretKey, "GET", "/v1/pm/portfolio");
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
