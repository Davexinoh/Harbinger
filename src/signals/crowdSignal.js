import {
  insertPoll, getPollByTelegramId, updatePollVotes,
  getActivePoll, getCrowdCalibration, getGroups, getRecentPolls, resolvePoll,
} from "../db/database.js";

let bot = null;

export function setCrowdBot(botInstance) {
  bot = botInstance;
}

const POLL_DURATION_SECONDS = 30 * 60; // 30 minutes

export async function postCrowdPoll(signals, match) {
  if (!bot) return;
  const groups = getGroups();
  if (!groups.length) return;

  const { composite, crypto, sports, sentiment } = signals;
  const eventTitle  = match?.event?.title;
  if (!eventTitle) {
    console.log("[CrowdSignal] No match found — skipping poll");
    return;
  }
  const direction   = crypto.score >= sports.score
    ? (crypto.direction === "UP" ? "YES" : "NO")
    : (sports.direction === "YES" ? "YES" : "NO");

  const question = buildPollQuestion(eventTitle, direction, composite);

  for (const group of groups) {
    const existing = getActivePoll(group.group_id);
    if (existing) continue;

    try {
      const contextMsg = buildContextMessage(signals, eventTitle, composite);
      await bot.sendMessage(group.group_id, contextMsg, { parse_mode: "Markdown" });

      const pollMsg = await bot.sendPoll(
        group.group_id,
        question,
        ["👍 YES — it happens", "👎 NO — it doesn't", "🤷 Too early to call"],
        { is_anonymous: false, open_period: POLL_DURATION_SECONDS }
      );

      insertPoll({
        telegram_poll_id: String(pollMsg.poll.id),
        group_id:         String(group.group_id),
        event_title:      eventTitle,
        event_id:         match?.event?.id || null,
        market_id:        match?.market?.id || null,
        composite_at_post: composite,
        engine_direction: direction,
      });

      console.log(`[CrowdSignal] Poll posted to group ${group.group_id} (30 min)`);
    } catch (err) {
      console.error(`[CrowdSignal] Poll post failed for group ${group.group_id}:`, err.message);
    }
  }
}

export function registerPollHandler(botInstance) {
  // Live vote updates
  botInstance.on("poll", (poll) => {
    const stored = getPollByTelegramId(String(poll.id));
    if (!stored) return;

    const yesVotes    = poll.options[0]?.voter_count || 0;
    const noVotes     = poll.options[1]?.voter_count || 0;
    const unsureVotes = poll.options[2]?.voter_count || 0;

    updatePollVotes(String(poll.id), yesVotes, noVotes, unsureVotes);

    // When Telegram sends poll with is_closed=true, auto-resolve into crowdiq
    if (poll.is_closed) {
      const totalVotes    = yesVotes + noVotes + unsureVotes;
      const crowdPredicts = yesVotes >= noVotes ? "YES" : "NO";
      // Use engine direction as the "actual" outcome for calibration
      // (real resolution happens when Bayse settles the market — this is crowd accuracy vs engine)
      if (stored.engine_direction) {
        const correct = resolvePoll(String(poll.id), stored.engine_direction);
        console.log(
          `[CrowdSignal] Poll ${poll.id} closed — crowd: ${crowdPredicts} | ` +
          `engine: ${stored.engine_direction} | correct: ${correct} | votes: ${totalVotes}`
        );
      }
    }
  });
}

export function getCrowdScore() {
  const groups = getGroups();
  if (!groups.length) return { source: "crowd", score: 0.5, direction: null, reason: "No groups" };

  const scores = [];
  for (const group of groups) {
    const poll = getActivePoll(group.group_id);
    if (poll?.crowd_score != null) {
      const votes = poll.votes_yes + poll.votes_no + poll.votes_unsure;
      scores.push({ score: poll.crowd_score, votes });
    }
  }

  if (!scores.length) return { source: "crowd", score: 0.5, direction: null, reason: "No active polls" };

  const totalVotes    = scores.reduce((s, p) => s + p.votes, 0);
  const weightedScore = totalVotes > 0
    ? scores.reduce((s, p) => s + p.score * (p.votes / totalVotes), 0)
    : scores.reduce((s, p) => s + p.score, 0) / scores.length;

  return {
    source:     "crowd",
    score:      weightedScore,
    direction:  weightedScore >= 0.5 ? "YES" : "NO",
    totalVotes,
    pollCount:  scores.length,
    fetched_at: new Date().toISOString(),
  };
}

export function getCrowdIQReport() { return getCrowdCalibration(); }
export { getRecentPolls };

function buildPollQuestion(eventTitle, direction, composite) {
  const confidence = (composite * 100).toFixed(0);
  const shortened  = eventTitle.length > 60 ? eventTitle.slice(0, 57) + "..." : eventTitle;
  return `Harbinger signals ${confidence}% confidence → "${shortened}" — Do you agree?`;
}

function buildContextMessage(signals, eventTitle, composite) {
  const { crypto, sports, sentiment } = signals;
  const bar = (score) => "█".repeat(Math.round(score * 10)) + "░".repeat(10 - Math.round(score * 10)) + ` ${(score * 100).toFixed(0)}%`;

  return (
    `🧠 *Community Wisdom Poll*\n\n` +
    `Signals converging on:\n*${eventTitle}*\n\n` +
    `Crypto    ${bar(crypto.score)}\n` +
    `Sports    ${bar(sports.score)}\n` +
    `Sentiment ${bar(sentiment.score)}\n` +
    `━━━━━━━━━━━━━━\n` +
    `Composite ⚡ ${bar(composite)}\n\n` +
    `_Poll closes in 30 minutes. Your vote feeds directly into the engine._`
  );
}
