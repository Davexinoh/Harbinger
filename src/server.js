import "dotenv/config";
import express     from "express";
import fetch       from "node-fetch";
import TelegramBot from "node-telegram-bot-api";

import { initSchema }      from "./db/database.js";
import { setBot }          from "./bot/alerts.js";
import { registerCommands } from "./bot/commands.js";
import { startEngine, stopEngine } from "./engine/engineLoop.js";
import { startSniper }     from "./engine/sniper.js";
import { startResolver }   from "./engine/resolver.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT  = process.env.PORT || 3001;

if (!TOKEN)                      { console.error("Missing TELEGRAM_BOT_TOKEN"); process.exit(1); }
if (!process.env.DATABASE_URL)   { console.error("Missing DATABASE_URL");       process.exit(1); }
if (!process.env.ENCRYPTION_KEY) { console.error("Missing ENCRYPTION_KEY");     process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: false });

// Clear webhook + any existing polling before starting
await bot.deleteWebhook({ drop_pending_updates: true });
await new Promise(r => setTimeout(r, 2000));
bot.startPolling();

setBot(bot);
registerCommands(bot);

bot.on("polling_error", err => {
  if (err.message.includes("409")) {
    console.error("[Bot] 409 Conflict — restarting polling in 5s");
    setTimeout(() => {
      bot.stopPolling();
      setTimeout(() => bot.startPolling(), 1000);
    }, 5000);
  } else {
    console.error("[Bot] Polling error:", err.message);
  }
});

const app = express();
app.use(express.json());
app.get("/",       (_, res) => res.json({ service: "Harbinger", ok: true }));
app.get("/health", (_, res) => res.json({ ok: true }));
app.get("/ping",   (_, res) => res.send("pong"));

app.listen(PORT, async () => {
  console.log(`[Server] Port ${PORT}`);
  await initSchema();
  startEngine();
  startSniper();
  startResolver();
  keepAlive();
});

function keepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url) return;
  const target = url.replace(/\/$/, "") + "/ping";
  console.log(`[KeepAlive] → ${target} every 14 min`);
  setInterval(async () => {
    try { await fetch(target); } catch {}
  }, 14 * 60 * 1000);
}

function shutdown() {
  bot.stopPolling();
  stopEngine();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT",  shutdown);
process.on("unhandledRejection", err => console.error("[Process] Unhandled:", err?.message));
process.on("uncaughtException",  err => console.error("[Process] Uncaught:", err?.message));
