import crypto from "crypto";

// Trim before validating. A trailing newline or space picked up while pasting
// the value into a dashboard is the usual reason this check fails, and
// whitespace is never valid hex — so trimming can only rescue a bad value, it
// can never alter the bytes of a good one.
const rawKey = (process.env.ENCRYPTION_KEY || "").trim();

if (!/^[0-9a-fA-F]{64}$/.test(rawKey)) {
  // Describe the shape of what we got, never the value itself.
  const detail =
    rawKey.length === 0
      ? "it is empty or unset"
      : `got ${rawKey.length} character(s)` +
        (/^[0-9a-fA-F]*$/.test(rawKey) ? "" : ", including non-hex characters");

  throw new Error(
    `ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes) — ${detail}. ` +
    "Generate one with: " +
    "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
  );
}

const KEY       = Buffer.from(rawKey, "hex");
const IV_LENGTH = 16;
const ALG       = "aes-256-cbc";

export function encrypt(text) {
  const iv        = crypto.randomBytes(IV_LENGTH);
  const cipher    = crypto.createCipheriv(ALG, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

export function decrypt(text) {
  if (!text) return null;
  const [ivHex, encHex] = text.split(":");
  if (!ivHex || !encHex) throw new Error("Invalid encrypted value format");
  const iv        = Buffer.from(ivHex, "hex");
  const encrypted = Buffer.from(encHex, "hex");
  const decipher  = crypto.createDecipheriv(ALG, KEY, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
