import crypto from "crypto";

const rawKey = process.env.ENCRYPTION_KEY || "";

if (!/^[0-9a-fA-F]{64}$/.test(rawKey)) {
  throw new Error(
    "ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). " +
    "Generate one with: node -e \"require('crypto').randomBytes(32).toString('hex')\""
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
