import pg from "pg";
import { encrypt, decrypt } from "../utils/encryption.js";

const { Pool } = pg;

let pool;

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
    });
    pool.on("error", (err) => console.error("[DB] Pool error:", err.message));
  }
  return pool;
}

export async function initSchema() {
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        chat_id            TEXT PRIMARY KEY,
        username           TEXT,
        bayse_pub_key      TEXT,
        bayse_sec_key      TEXT,
        threshold          REAL    NOT NULL DEFAULT 0.60,
        max_trade_usd      REAL    NOT NULL DEFAULT 5.0,
        currency           TEXT    NOT NULL DEFAULT 'USD',
        preferred_category TEXT,
        engine_active      INTEGER NOT NULL DEFAULT 0,
        setup_step         TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS trades (
        id             SERIAL PRIMARY KEY,
        chat_id        TEXT    NOT NULL,
        event_id       TEXT    NOT NULL,
        market_id      TEXT    NOT NULL,
        event_title    TEXT    NOT NULL,
        outcome_label  TEXT,
        signal_source  TEXT    NOT NULL,
        confidence     REAL    NOT NULL,
        side           TEXT    NOT NULL,
        outcome        TEXT    NOT NULL,
        amount         REAL    NOT NULL,
        currency       TEXT    NOT NULL,
        expected_price REAL,
        status         TEXT    NOT NULL DEFAULT 'open',
        pnl            REAL,
        executed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at    TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS groups_list (
        group_id  TEXT PRIMARY KEY,
        title     TEXT,
        broadcast INTEGER NOT NULL DEFAULT 1,
        added_by  TEXT,
        added_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS signal_log (
        id            SERIAL PRIMARY KEY,
        signal_source TEXT    NOT NULL,
        score         REAL    NOT NULL,
        meta          TEXT,
        logged_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS polls (
        id                 SERIAL PRIMARY KEY,
        telegram_poll_id   TEXT    UNIQUE NOT NULL,
        group_id           TEXT    NOT NULL,
        event_title        TEXT    NOT NULL,
        event_id           TEXT,
        market_id          TEXT,
        composite_at_post  REAL    NOT NULL,
        engine_direction   TEXT,
        votes_yes          INTEGER NOT NULL DEFAULT 0,
        votes_no           INTEGER NOT NULL DEFAULT 0,
        votes_unsure       INTEGER NOT NULL DEFAULT 0,
        crowd_score        REAL,
        resolved           INTEGER NOT NULL DEFAULT 0,
        actual_outcome     TEXT,
        crowd_was_right    INTEGER,
        posted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_at          TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS crowd_calibration (
        id           SERIAL PRIMARY KEY,
        category     TEXT    NOT NULL DEFAULT 'general',
        total_polls  INTEGER NOT NULL DEFAULT 0,
        correct      INTEGER NOT NULL DEFAULT 0,
        last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      INSERT INTO crowd_calibration (category) VALUES ('general')
      ON CONFLICT DO NOTHING;
    `);

    // Safe migrations — add columns that may not exist in older DBs
    const migrations = [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_category TEXT`,
      `ALTER TABLE trades ADD COLUMN IF NOT EXISTS outcome_label TEXT`,
    ];
    for (const m of migrations) {
      try { await client.query(m); } catch (_) {}
    }

    console.log("[DB] Schema initialized");
  } finally {
    client.release();
  }
}

// ─── Users ────────────────────────────────────────────────────────────────────

export async function upsertUser(chatId, username) {
  await getPool().query(`
    INSERT INTO users (chat_id, username)
    VALUES ($1, $2)
    ON CONFLICT (chat_id) DO UPDATE SET username = EXCLUDED.username
  `, [String(chatId), username || null]);
}

export async function getUser(chatId) {
  const res = await getPool().query("SELECT * FROM users WHERE chat_id = $1", [String(chatId)]);
  return res.rows[0] || null;
}

export async function updateUser(chatId, fields) {
  const keys = Object.keys(fields);
  const vals = keys.map(k => fields[k]);
  const set  = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  await getPool().query(`UPDATE users SET ${set} WHERE chat_id = $${keys.length + 1}`, [...vals, String(chatId)]);
}

export async function getActiveUsers() {
  const res = await getPool().query("SELECT * FROM users WHERE engine_active = 1");
  return res.rows;
}

// ─── Trades ───────────────────────────────────────────────────────────────────

export async function insertTrade(trade) {
  const res = await getPool().query(`
    INSERT INTO trades
      (chat_id, event_id, market_id, event_title, outcome_label, signal_source,
       confidence, side, outcome, amount, currency, expected_price, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING id
  `, [
    trade.chat_id, trade.event_id, trade.market_id, trade.event_title,
    trade.outcome_label || null, trade.signal_source, trade.confidence,
    trade.side, trade.outcome, trade.amount, trade.currency,
    trade.expected_price || null, trade.status || "open",
  ]);
  return res.rows[0];
}

export async function updateTrade(id, fields) {
  const keys = Object.keys(fields);
  const vals = keys.map(k => fields[k]);
  const set  = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  await getPool().query(`UPDATE trades SET ${set} WHERE id = $${keys.length + 1}`, [...vals, id]);
}

export async function getRecentTrades(chatId, limit = 10) {
  const res = await getPool().query(
    "SELECT * FROM trades WHERE chat_id = $1 ORDER BY executed_at DESC LIMIT $2",
    [String(chatId), limit]
  );
  return res.rows;
}

export async function getOpenTrades() {
  const res = await getPool().query(
    "SELECT t.*, u.bayse_pub_key, u.bayse_sec_key FROM trades t JOIN users u ON u.chat_id = t.chat_id WHERE t.status = 'open' ORDER BY t.executed_at ASC"
  );
  return res.rows;
}

export async function getPnL(chatId) {
  const res = await getPool().query(`
    SELECT
      COUNT(*)::int                                            AS total_trades,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)::int          AS wins,
      SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END)::int         AS losses,
      COALESCE(SUM(pnl), 0)                                   AS total_pnl,
      COALESCE(AVG(confidence), 0)                            AS avg_confidence
    FROM trades
    WHERE chat_id = $1 AND status = 'resolved'
  `, [String(chatId)]);
  return res.rows[0];
}

export async function getUnsettledEventIds(chatId) {
  const res = await getPool().query(
    "SELECT event_id FROM trades WHERE chat_id = $1 AND status = 'open'",
    [String(chatId)]
  );
  return new Set(res.rows.map(r => r.event_id));
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────

export async function getLeaderboard(limit = 10) {
  const res = await getPool().query(`
    SELECT
      u.chat_id, u.username,
      COUNT(t.id)::int                                          AS total_trades,
      SUM(CASE WHEN t.pnl > 0 THEN 1 ELSE 0 END)::int         AS wins,
      COALESCE(SUM(t.pnl), 0)                                  AS total_pnl,
      CASE WHEN COUNT(t.id) > 0
        THEN ROUND(SUM(CASE WHEN t.pnl > 0 THEN 1 ELSE 0 END)::numeric / COUNT(t.id) * 100, 1)
        ELSE 0 END                                             AS win_rate
    FROM users u
    LEFT JOIN trades t ON t.chat_id = u.chat_id AND t.status = 'resolved'
    GROUP BY u.chat_id, u.username
    HAVING COUNT(t.id) >= 3
    ORDER BY win_rate DESC, total_pnl DESC
    LIMIT $1
  `, [limit]);
  return res.rows;
}

// ─── Groups ───────────────────────────────────────────────────────────────────

export async function upsertGroup(groupId, title, addedBy) {
  await getPool().query(`
    INSERT INTO groups_list (group_id, title, added_by)
    VALUES ($1, $2, $3)
    ON CONFLICT (group_id) DO UPDATE SET title = EXCLUDED.title
  `, [String(groupId), title || null, String(addedBy)]);
}

export async function getGroups() {
  const res = await getPool().query("SELECT * FROM groups_list WHERE broadcast = 1");
  return res.rows;
}

export async function removeGroup(groupId) {
  await getPool().query("UPDATE groups_list SET broadcast = 0 WHERE group_id = $1", [String(groupId)]);
}

// ─── Signal log ───────────────────────────────────────────────────────────────

export async function logSignal(source, score, meta) {
  await getPool().query(
    "INSERT INTO signal_log (signal_source, score, meta) VALUES ($1, $2, $3)",
    [source, score, meta ? JSON.stringify(meta) : null]
  );
}

// ─── Polls ────────────────────────────────────────────────────────────────────

export async function insertPoll(poll) {
  await getPool().query(`
    INSERT INTO polls
      (telegram_poll_id, group_id, event_title, event_id, market_id, composite_at_post, engine_direction)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, [poll.telegram_poll_id, poll.group_id, poll.event_title, poll.event_id,
      poll.market_id, poll.composite_at_post, poll.engine_direction]);
}

export async function getPollByTelegramId(telegramPollId) {
  const res = await getPool().query("SELECT * FROM polls WHERE telegram_poll_id = $1", [String(telegramPollId)]);
  return res.rows[0] || null;
}

export async function updatePollVotes(telegramPollId, votesYes, votesNo, votesUnsure) {
  const total       = votesYes + votesNo + votesUnsure;
  const unsurePct   = total > 0 ? votesUnsure / total : 0;
  const crowdScore  = total > 0 ? (votesYes / total) * (1 - unsurePct * 0.4) : null;
  await getPool().query(`
    UPDATE polls SET votes_yes=$1, votes_no=$2, votes_unsure=$3, crowd_score=$4
    WHERE telegram_poll_id=$5
  `, [votesYes, votesNo, votesUnsure, crowdScore, String(telegramPollId)]);
  return crowdScore;
}

export async function resolvePoll(telegramPollId, actualOutcome) {
  const poll = await getPollByTelegramId(telegramPollId);
  if (!poll) return;
  const crowdPredicts = poll.votes_yes >= poll.votes_no ? "YES" : "NO";
  const correct       = crowdPredicts === actualOutcome ? 1 : 0;
  await getPool().query(`
    UPDATE polls SET resolved=1, actual_outcome=$1, crowd_was_right=$2, closed_at=NOW()
    WHERE telegram_poll_id=$3
  `, [actualOutcome, correct, String(telegramPollId)]);
  await getPool().query(`
    UPDATE crowd_calibration SET total_polls=total_polls+1, correct=correct+$1, last_updated=NOW()
    WHERE category='general'
  `, [correct]);
  return correct;
}

export async function getActivePoll(groupId) {
  const res = await getPool().query(`
    SELECT * FROM polls WHERE group_id=$1 AND resolved=0 ORDER BY posted_at DESC LIMIT 1
  `, [String(groupId)]);
  return res.rows[0] || null;
}

export async function getCrowdCalibration() {
  const res = await getPool().query(`
    SELECT c.total_polls, c.correct,
      CASE WHEN c.total_polls > 0
        THEN ROUND(c.correct::numeric / c.total_polls * 100, 1) ELSE 0 END AS accuracy_pct,
      (SELECT COUNT(*) FROM polls WHERE resolved=0)::int AS active_polls,
      (SELECT COALESCE(AVG(votes_yes+votes_no+votes_unsure),0) FROM polls WHERE resolved=1) AS avg_votes_per_poll
    FROM crowd_calibration c WHERE c.category='general'
  `);
  return res.rows[0] || null;
}

export async function getRecentPolls(limit = 5) {
  const res = await getPool().query("SELECT * FROM polls ORDER BY posted_at DESC LIMIT $1", [limit]);
  return res.rows;
}
