import "dotenv/config";
import express     from "express";
import fetch       from "node-fetch";
import TelegramBot from "node-telegram-bot-api";

import { initSchema }             from "./db/database.js";
import { setBot }                 from "./bot/alerts.js";
import { registerCommands }       from "./bot/commands.js";
import { startEngine, stopEngine } from "./engine/engineLoop.js";
import { startResolver }          from "./engine/resolver.js";

// ─── Env validation ───────────────────────────────────────────────────────────
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT  = process.env.PORT || 3001;

if (!TOKEN)                    { console.error("[Startup] Missing TELEGRAM_BOT_TOKEN"); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error("[Startup] Missing DATABASE_URL");       process.exit(1); }

const encKey = process.env.ENCRYPTION_KEY || "";
if (!/^[0-9a-fA-F]{64}$/.test(encKey)) {
  console.error("[Startup] ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). " +
    "Generate one with: node -e \"require('crypto').randomBytes(32).toString('hex')\"");
  process.exit(1);
}

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.get("/",       (_, res) => res.json({ service: "Harbinger", ok: true }));
app.get("/health", (_, res) => res.json({ ok: true }));
app.get("/ping",   (_, res) => res.send("pong"));

// ─── Startup ──────────────────────────────────────────────────────────────────
async function main() {
  // Create bot without polling first so we can clear any existing webhook/session
  const bot = new TelegramBot(TOKEN, { polling: false });

  try {
    await bot.deleteWebHook();
    console.log("[Bot] Webhook cleared");
  } catch (err) {
    console.warn("[Bot] deleteWebHook failed (non-fatal):", err.message);
  }

  // Now start polling cleanly
  bot.startPolling({ restart: false });
  bot.on("polling_error", err => console.error("[Bot] Polling error:", err.message));

  setBot(bot);
  registerCommands(bot);

  app.listen(PORT, async () => {
    console.log(`[Server] Port ${PORT}`);
    await initSchema();
    startEngine();
    startResolver();
    keepAlive();
  });

  // ─── Graceful shutdown ──────────────────────────────────────────────────────
  function shutdown() {
    bot.stopPolling();
    stopEngine();
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT",  shutdown);
  process.on("unhandledRejection", err => console.error("[Process] Unhandled:", err?.message));
  process.on("uncaughtException",  err => console.error("[Process] Uncaught:",  err?.message));
}

main().catch(err => {
  console.error("[Startup] Fatal:", err.message);
  process.exit(1);
});

// ─── Keep-alive (Render free tier) ────────────────────────────────────────────
function keepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url) return;
  const target = url.replace(/\/$/, "") + "/ping";
  setInterval(async () => {
    try { await fetch(target); } catch {}
  }, 14 * 60 * 1000);
}
