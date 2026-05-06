export async function signedRequest(pubKey, secKey, method, path, body = null) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyStr   = body ? JSON.stringify(body) : "";
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
