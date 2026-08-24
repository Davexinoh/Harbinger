import "dotenv/config";
import express     from "express";
import TelegramBot from "node-telegram-bot-api";

import { initSchema }       from "./db/database.js";
import { setBot }           from "./bot/alerts.js";
import { registerCommands } from "./bot/commands.js";
import { startEngine, stopEngine } from "./engine/engineLoop.js";
import { startSniper }      from "./engine/sniper.js";
import { startResolver }    from "./engine/resolver.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT  = process.env.PORT || 3001;

if (!TOKEN)                      { console.error("Missing TELEGRAM_BOT_TOKEN"); process.exit(1); }
if (!process.env.DATABASE_URL)   { console.error("Missing DATABASE_URL");       process.exit(1); }
if (!process.env.ENCRYPTION_KEY) { console.error("Missing ENCRYPTION_KEY");     process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: false });

setBot(bot);
registerCommands(bot);

// ─── Telegram polling ─────────────────────────────────────────────────────────

// Telegram allows exactly one getUpdates consumer per token. Clearing any
// webhook first stops a stale webhook from swallowing updates.
//
// A rejected token here would otherwise surface as a top-level rejection that
// dumps the whole HTTP response object, and with instant restarts that floods
// the platform's log rate limit. Fail in one readable line instead.
try {
  await bot.setWebHook("");
  await bot.startPolling();
} catch (err) {
  const status = err?.response?.statusCode;
  console.error(
    `[Bot] Telegram rejected TELEGRAM_BOT_TOKEN (HTTP ${status ?? "unknown"}). ` +
    "401 means the token is revoked, malformed, or has stray characters."
  );
  process.exit(1);
}

let restartingPolling = false;

bot.on("polling_error", err => {
  const msg = err?.message || String(err);

  // 409 means a second instance is polling the same token. Restarting on every
  // 409 stacks concurrent restart chains and turns a transient overlap into a
  // permanent storm, so collapse them into one in-flight restart.
  if (!msg.includes("409")) {
    console.error("[Bot] Polling error:", msg);
    return;
  }
  if (restartingPolling) return;

  restartingPolling = true;
  console.error("[Bot] 409 Conflict — another instance holds this token. Retrying in 5s");
  setTimeout(async () => {
    try {
      await bot.stopPolling({ cancel: true });
      await bot.startPolling();
      console.log("[Bot] Polling restarted");
    } catch (e) {
      console.error("[Bot] Polling restart failed:", e?.message);
    } finally {
      restartingPolling = false;
    }
  }, 5_000);
});

// ─── HTTP surface (healthcheck only) ──────────────────────────────────────────

const app = express();
app.use(express.json());
app.get("/",       (_, res) => res.json({ service: "Harbinger", ok: true }));
app.get("/health", (_, res) => res.json({ ok: true }));
app.get("/ping",   (_, res) => res.send("pong"));

// ─── Boot ─────────────────────────────────────────────────────────────────────

try {
  await initSchema();
} catch (err) {
  // Running the engine without a database means trades cannot be recorded or
  // resolved. Fail fast and let the platform restart us instead.
  console.error("[Boot] Schema init failed:", err?.message);
  process.exit(1);
}

startEngine();
startSniper();
startResolver();

const server = app.listen(PORT, () => console.log(`[Server] Port ${PORT}`));

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let shuttingDown = false;

function shutdown(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Process] ${signal} — shutting down`);

  stopEngine();
  bot.stopPolling({ cancel: true }).catch(() => {});
  server.close(() => process.exit(code));

  // Don't let a hung socket hold the container open past the platform's
  // grace period.
  setTimeout(() => process.exit(code), 8_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

process.on("unhandledRejection", err =>
  console.error("[Process] Unhandled rejection:", err?.message)
);

// An uncaught exception leaves the process in an undefined state. For a bot
// that signs and places real orders, limping on is worse than restarting.
// Exit non-zero so the platform records a failure and restarts us.
process.on("uncaughtException", err => {
  console.error("[Process] Uncaught exception:", err?.stack || err?.message);
  shutdown("uncaughtException", 1);
});
