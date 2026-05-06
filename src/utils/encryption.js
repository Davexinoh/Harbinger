import crypto from "crypto";

const KEY = Buffer.from(process.env.ENCRYPTION_KEY || "", "hex");
const IV_LENGTH = 16;
const ALG = "aes-256-cbc";

export function encrypt(text) {
  const iv  = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALG, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

export function decrypt(text) {
  if (!text) return null;
  const [ivHex, encHex] = text.split(":");
  const iv        = Buffer.from(ivHex, "hex");
  const encrypted = Buffer.from(encHex, "hex");
  const decipher  = crypto.createDecipheriv(ALG, KEY, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
