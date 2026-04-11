import {
  insertPoll,
  getPollByTelegramId,
  updatePollVotes,
  getActivePoll,
  getCrowdCalibration,
} from "../db/database.js";
import { getGroups } from "../db/database.js";

let bot = null;

export function setCrowdBot(botInstance) {
  bot = botInstance;
}

// ─── Post a crowd wisdom poll to all groups ───────────────────────────────────

export async function postCrowdPoll(signals, match) {
  if (!bot) return;

  const groups = getGroups();
  if (!groups.length) return;

  const { composite, crypto, sports, sentiment } = signals;
  const eventTitle = match?.event?.title || "Upcoming Market Event";
  const direction = signals.crypto.score >= signals.sports.score
    ? (crypto.direction === "UP" ? "YES" : "NO")
    : (sports.direction === "home" ? "YES" : "NO");

  const question = buildPollQuestion(eventTitle, direction, composite);

  for (const group of groups) {
    // Don't post if there's already an unresolved poll in this group
    const existing = getActivePoll(group.group_id);
    if (existing) continue;

    try {
      const contextMsg = buildContextMessage(signals, eventTitle, composite);
      await bot.sendMessage(group.group_id, contextMsg, { parse_mode: "Markdown" });

      const pollMsg = await bot.sendPoll(
        group.group_id,
        question,
        ["👍 YES — it happens", "👎 NO — it doesn't", "🤷 Too early to call"],
        {
          is_anonymous: false,
          open_period: 300, // closes after 5 minutes — keeps it tight
        }
      );

      // Store in DB
      insertPoll({
        telegram_poll_id: String(pollMsg.poll.id),
        group_id: String(group.group_id),
        event_title: eventTitle,
        event_id: match?.event?.id || null,
        market_id: match?.market?.id || null,
        composite_at_post: composite,
        engine_direction: direction,
      });

      console.log(`[CrowdSignal] Poll posted to group ${group.group_id}`);
    } catch (err) {
      console.error(`[CrowdSignal] Poll post failed for group ${group.group_id}:`, err.message);
    }
  }
}

// ─── Handle incoming poll answer updates ─────────────────────────────────────

export function registerPollHandler(botInstance) {
  botInstance.on("poll", async (poll) => {
    const stored = getPollByTelegramId(String(poll.id));
    if (!stored) return; // not our poll

    const yesOption = poll.options[0];
    const noOption = poll.options[1];
    const unsureOption = poll.options[2];

    const crowdScore = updatePollVotes(
      String(poll.id),
      yesOption?.voter_count || 0,
      noOption?.voter_count || 0,
      unsureOption?.voter_count || 0
    );

    console.log(
      `[CrowdSignal] Poll ${poll.id} updated — ` +
      `YES:${yesOption?.voter_count} NO:${noOption?.voter_count} ` +
      `UNSURE:${unsureOption?.voter_count} → crowd_score: ${crowdScore?.toFixed(3)}`
    );
  });
}

// ─── Get current crowd signal score ──────────────────────────────────────────
// Called by scorer.js each tick — returns latest active crowd consensus

export function getCrowdSignalScore(groupIds) {
  if (!groupIds?.length) return { source: "crowd", score: 0.5, direction: null, reason: "No groups" };

  const db = (await import("../db/database.js")).getDb?.();

  // Pull crowd_score from most recently posted unresolved polls across all groups
  const scores = [];
  for (const groupId of groupIds) {
    const poll = getActivePoll(groupId);
    if (poll?.crowd_score != null) {
      scores.push(poll.crowd_score);
    }
  }

  if (!scores.length) {
    return { source: "crowd", score: 0.5, direction: null, reason: "No active polls" };
  }

  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;

  return {
    source: "crowd",
    score: avg,
    direction: avg >= 0.5 ? "YES" : "NO",
    pollCount: scores.length,
  };
}

// ─── Sync crowd score into the engine (called from scorer.js) ─────────────────

export async function getCrowdScore() {
  const groups = getGroups();
  const groupIds = groups.map((g) => g.group_id);

  if (!groupIds.length) {
    return { source: "crowd", score: 0.5, direction: null, reason: "No groups registered" };
  }

  const scores = [];
  for (const groupId of groupIds) {
    const poll = getActivePoll(groupId);
    if (poll?.crowd_score != null) {
      scores.push({ score: poll.crowd_score, votes: poll.votes_yes + poll.votes_no + poll.votes_unsure });
    }
  }

  if (!scores.length) {
    return { source: "crowd", score: 0.5, direction: null, reason: "No active polls" };
  }

  // Weight by vote count — more votes = more signal
  const totalVotes = scores.reduce((s, p) => s + p.votes, 0);
  const weightedScore = totalVotes > 0
    ? scores.reduce((s, p) => s + p.score * (p.votes / totalVotes), 0)
    : scores.reduce((s, p) => s + p.score, 0) / scores.length;

  return {
    source: "crowd",
    score: weightedScore,
    direction: weightedScore >= 0.5 ? "YES" : "NO",
    totalVotes,
    pollCount: scores.length,
    fetched_at: new Date().toISOString(),
  };
}

// ─── Crowd IQ summary ─────────────────────────────────────────────────────────

export function getCrowdIQReport() {
  return getCrowdCalibration();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildPollQuestion(eventTitle, direction, composite) {
  const confidence = (composite * 100).toFixed(0);
  const shortened = eventTitle.length > 60 ? eventTitle.slice(0, 57) + "..." : eventTitle;
  return `Harbinger signals ${confidence}% confidence → "${shortened}" — Do you agree?`;
}

function buildContextMessage(signals, eventTitle, composite) {
  const { crypto, sports, sentiment } = signals;

  const bar = (score) => {
    const filled = Math.round(score * 10);
    return "█".repeat(filled) + "░".repeat(10 - filled) + ` ${(score * 100).toFixed(0)}%`;
  };

  return (
    `🧠 *Community Wisdom Poll*\n\n` +
    `Signals are converging on:\n*${eventTitle}*\n\n` +
    `Crypto    ${bar(crypto.score)}\n` +
    `Sports    ${bar(sports.score)}\n` +
    `Sentiment ${bar(sentiment.score)}\n` +
    `━━━━━━━━━━━━━━\n` +
    `Composite ⚡ ${bar(composite)}\n\n` +
    `_Your vote feeds directly into the engine's 4th signal._\n` +
    `_High crowd agreement boosts trade confidence. Disagreement dampens it._`
  );
}
