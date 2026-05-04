import "dotenv/config";
import express    from "express";
import fetch      from "node-fetch";
import TelegramBot from "node-telegram-bot-api";
import { registerCommands }                            from "./bot/commands.js";
import { registerMarketMakerCommands }                 from "./bot/marketMakerCommands.js";
import { setBot }                                      from "./bot/alerts.js";
import { setCrowdBot, registerPollHandler, getCrowdIQReport, getRecentPolls } from "./signals/crowdSignal.js";
import { startEngine }                                 from "./engine/engineLoop.js";
import { startTradeResolver, setResolverBot }          from "./engine/tradeResolver.js";
import { setMarketMakerBot }                           from "./engine/marketMaker.js";
import { initSchema }                                  from "./db/database.js";

const PORT  = process.env.PORT || 3001;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TOKEN)                    { console.error("FATAL: TELEGRAM_BOT_TOKEN not set"); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error("FATAL: DATABASE_URL not set");       process.exit(1); }

// ─── Telegram Bot ─────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });
setBot(bot);
setCrowdBot(bot);
setResolverBot(bot);
setMarketMakerBot(bot);

registerCommands(bot);
registerMarketMakerCommands(bot);
registerPollHandler(bot);

// /crowdiq — registered here to avoid circular imports
bot.onText(/\/crowdiq/, async (msg) => {
  const chatId = msg.chat.id;
  const stats  = await getCrowdIQReport();
  const recent = await getRecentPolls(5);

  if (!stats || stats.total_polls === 0) {
    return bot.sendMessage(chatId,
      `🧠 *Crowd IQ*\n\nNo resolved polls yet.\n\n_Add Harbinger to a group to start collecting votes._`,
      { parse_mode: "Markdown" }
    );
  }

  const iqRating =
    stats.accuracy_pct >= 70 ? "🔥 Sharp"
    : stats.accuracy_pct >= 55 ? "✅ Above Average"
    : stats.accuracy_pct >= 45 ? "⚪ Average"
    : "⚠️ Below Average";

  const recentLines = (recent || [])
    .filter(p => p.resolved)
    .slice(0, 3)
    .map(p => {
      const result = p.crowd_was_right ? "✅" : "❌";
      const votes  = p.votes_yes + p.votes_no + p.votes_unsure;
      return `${result} "${p.event_title.slice(0, 40)}" — ${votes} votes`;
    }).join("\n");

  return bot.sendMessage(chatId,
    `🧠 *Harbinger Crowd IQ*\n\n` +
    `Rating: *${iqRating}*\n` +
    `Accuracy: \`${stats.accuracy_pct}%\` (${stats.correct}/${stats.total_polls} correct)\n` +
    `Avg votes/poll: \`${Math.round(stats.avg_votes_per_poll || 0)}\`\n` +
    `Active polls: \`${stats.active_polls}\`\n\n` +
    (recentLines ? `*Recent Polls*\n${recentLines}\n\n` : "") +
    `_Polls are for engagement only — they no longer influence trade decisions._`,
    { parse_mode: "Markdown" }
  );
});

bot.on("polling_error", err => console.error("[Bot] Polling error:", err.message));
console.log("[Bot] Telegram bot started");

// ─── Express ──────────────────────────────────────────────────────────────────
const app       = express();
const startTime = Date.now();
app.use(express.json());
app.get("/",       (_, res) => res.json({ service: "Harbinger", status: "running" }));
app.get("/health", (_, res) => res.json({ ok: true, uptime: Math.floor((Date.now() - startTime) / 1000) }));
app.get("/ping",   (_, res) => res.send("pong"));

const server = app.listen(PORT, async () => {
  console.log(`[Server] Harbinger on port ${PORT}`);
  try {
    await initSchema();
  } catch (err) {
    console.error("[DB] Schema init failed:", err.message);
    process.exit(1);
  }
  startEngine();
  startTradeResolver();
  startKeepAlive();
});

// ─── Keep-alive ───────────────────────────────────────────────────────────────
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
let pingCount  = 0;

function startKeepAlive() {
  if (!SELF_URL) { console.warn("[KeepAlive] RENDER_EXTERNAL_URL not set"); return; }
  const target = `${SELF_URL.replace(/\/$/, "")}/ping`;
  console.log(`[KeepAlive] → ${target} every 14 min`);
  pingSelf(target);
  setInterval(() => pingSelf(target), 14 * 60 * 1000);
}

async function pingSelf(url) {
  try {
    const res = await fetch(url, { timeout: 10_000 });
    console.log(`[KeepAlive] Ping #${++pingCount} → ${res.ok ? "ok" : res.status}`);
  } catch (err) {
    console.error(`[KeepAlive] Ping failed → ${err.message}`);
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown(sig) {
  console.log(`[Server] ${sig} — shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// ─── Global error handlers — prevent crashes ─────────────────────────────────
process.on("unhandledRejection", (err) => {
  console.error("[Process] Unhandled rejection:", err?.message || err);
});
process.on("uncaughtException", (err) => {
  console.error("[Process] Uncaught exception:", err?.message || err);
});
