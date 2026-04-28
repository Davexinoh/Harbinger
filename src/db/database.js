import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, "../../harbinger.db");

let db;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
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
      created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS trades (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id        TEXT    NOT NULL,
      event_id       TEXT    NOT NULL,
      market_id      TEXT    NOT NULL,
      event_title    TEXT    NOT NULL,
      signal_source  TEXT    NOT NULL,
      confidence     REAL    NOT NULL,
      side           TEXT    NOT NULL,
      outcome        TEXT    NOT NULL,
      amount         REAL    NOT NULL,
      currency       TEXT    NOT NULL,
      expected_price REAL,
      status         TEXT    NOT NULL DEFAULT 'pending',
      pnl            REAL,
      executed_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      resolved_at    TEXT,
      FOREIGN KEY (chat_id) REFERENCES users(chat_id)
    );

    CREATE TABLE IF NOT EXISTS groups (
      group_id  TEXT PRIMARY KEY,
      title     TEXT,
      broadcast INTEGER NOT NULL DEFAULT 1,
      added_by  TEXT,
      added_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS signal_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_source TEXT    NOT NULL,
      score         REAL    NOT NULL,
      meta          TEXT,
      logged_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS polls (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
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
      posted_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      closed_at          TEXT
    );

    CREATE TABLE IF NOT EXISTS crowd_calibration (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      category     TEXT    NOT NULL DEFAULT 'general',
      total_polls  INTEGER NOT NULL DEFAULT 0,
      correct      INTEGER NOT NULL DEFAULT 0,
      last_updated TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrate: add preferred_category if it doesn't exist yet
  try {
    db.exec(`ALTER TABLE users ADD COLUMN preferred_category TEXT`);
  } catch (_) { /* column already exists — ignore */ }
}

// ─── Users ────────────────────────────────────────────────────────────────────

export function upsertUser(chatId, username) {
  getDb().prepare(`
    INSERT INTO users (chat_id, username)
    VALUES (?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET username = excluded.username
  `).run(String(chatId), username || null);
}

export function getUser(chatId) {
  return getDb().prepare("SELECT * FROM users WHERE chat_id = ?").get(String(chatId));
}

export function updateUser(chatId, fields) {
  const keys = Object.keys(fields);
  const set  = keys.map(k => `${k} = ?`).join(", ");
  const vals = keys.map(k => fields[k]);
  getDb().prepare(`UPDATE users SET ${set} WHERE chat_id = ?`).run(...vals, String(chatId));
}

export function getActiveUsers() {
  return getDb().prepare("SELECT * FROM users WHERE engine_active = 1").all();
}

// ─── Trades ───────────────────────────────────────────────────────────────────

export function insertTrade(trade) {
  return getDb().prepare(`
    INSERT INTO trades
      (chat_id, event_id, market_id, event_title, signal_source,
       confidence, side, outcome, amount, currency, expected_price, status)
    VALUES
      (@chat_id, @event_id, @market_id, @event_title, @signal_source,
       @confidence, @side, @outcome, @amount, @currency, @expected_price, @status)
  `).run(trade);
}

export function updateTrade(id, fields) {
  const keys = Object.keys(fields);
  const set  = keys.map(k => `${k} = ?`).join(", ");
  const vals = keys.map(k => fields[k]);
  getDb().prepare(`UPDATE trades SET ${set} WHERE id = ?`).run(...vals, id);
}

export function getRecentTrades(chatId, limit = 10) {
  return getDb()
    .prepare("SELECT * FROM trades WHERE chat_id = ? ORDER BY executed_at DESC LIMIT ?")
    .all(String(chatId), limit);
}

export function getPnL(chatId) {
  return getDb().prepare(`
    SELECT
      COUNT(*)                                   AS total_trades,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)  AS wins,
      SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) AS losses,
      COALESCE(SUM(pnl), 0)                      AS total_pnl,
      COALESCE(AVG(confidence), 0)               AS avg_confidence
    FROM trades
    WHERE chat_id = ? AND status = 'resolved'
  `).get(String(chatId));
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────

export function getLeaderboard(limit = 10) {
  return getDb().prepare(`
    SELECT
      u.chat_id,
      u.username,
      COUNT(t.id)                                   AS total_trades,
      SUM(CASE WHEN t.pnl > 0 THEN 1 ELSE 0 END)   AS wins,
      COALESCE(SUM(t.pnl), 0)                       AS total_pnl,
      CASE WHEN COUNT(t.id) > 0
        THEN ROUND(CAST(SUM(CASE WHEN t.pnl > 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(t.id) * 100, 1)
        ELSE 0
      END AS win_rate
    FROM users u
    LEFT JOIN trades t ON t.chat_id = u.chat_id AND t.status = 'resolved'
    GROUP BY u.chat_id
    HAVING total_trades >= 3
    ORDER BY win_rate DESC, total_pnl DESC
    LIMIT ?
  `).all(limit);
}

// ─── Groups ───────────────────────────────────────────────────────────────────

export function upsertGroup(groupId, title, addedBy) {
  getDb().prepare(`
    INSERT INTO groups (group_id, title, added_by)
    VALUES (?, ?, ?)
    ON CONFLICT(group_id) DO UPDATE SET title = excluded.title
  `).run(String(groupId), title || null, String(addedBy));
}

export function getGroups() {
  return getDb().prepare("SELECT * FROM groups WHERE broadcast = 1").all();
}

export function removeGroup(groupId) {
  getDb().prepare("UPDATE groups SET broadcast = 0 WHERE group_id = ?").run(String(groupId));
}

// ─── Signal log ───────────────────────────────────────────────────────────────

export function logSignal(source, score, meta) {
  getDb()
    .prepare("INSERT INTO signal_log (signal_source, score, meta) VALUES (?, ?, ?)")
    .run(source, score, meta ? JSON.stringify(meta) : null);
}

// ─── Polls ────────────────────────────────────────────────────────────────────

export function insertPoll(poll) {
  return getDb().prepare(`
    INSERT INTO polls
      (telegram_poll_id, group_id, event_title, event_id, market_id,
       composite_at_post, engine_direction)
    VALUES
      (@telegram_poll_id, @group_id, @event_title, @event_id, @market_id,
       @composite_at_post, @engine_direction)
  `).run(poll);
}

export function getPollByTelegramId(telegramPollId) {
  return getDb()
    .prepare("SELECT * FROM polls WHERE telegram_poll_id = ?")
    .get(String(telegramPollId));
}

export function updatePollVotes(telegramPollId, votesYes, votesNo, votesUnsure) {
  const total       = votesYes + votesNo + votesUnsure;
  const unsurePenalty = total > 0 ? votesUnsure / total : 0;
  const crowdScore  = total > 0
    ? (votesYes / total) * (1 - unsurePenalty * 0.4)
    : null;

  getDb().prepare(`
    UPDATE polls
    SET votes_yes = ?, votes_no = ?, votes_unsure = ?, crowd_score = ?
    WHERE telegram_poll_id = ?
  `).run(votesYes, votesNo, votesUnsure, crowdScore, String(telegramPollId));

  return crowdScore;
}

export function resolvePoll(telegramPollId, actualOutcome) {
  const poll = getPollByTelegramId(telegramPollId);
  if (!poll) return;
  const crowdPrediction = poll.votes_yes > poll.votes_no ? "YES" : "NO";
  const crowdWasRight   = crowdPrediction === actualOutcome ? 1 : 0;
  getDb().prepare(`
    UPDATE polls
    SET resolved = 1, actual_outcome = ?, crowd_was_right = ?, closed_at = datetime('now')
    WHERE telegram_poll_id = ?
  `).run(actualOutcome, crowdWasRight, String(telegramPollId));
  const existing = getDb().prepare("SELECT * FROM crowd_calibration WHERE category = 'general'").get();
  if (existing) {
    getDb().prepare(`UPDATE crowd_calibration SET total_polls = total_polls + 1, correct = correct + ?, last_updated = datetime('now') WHERE category = 'general'`).run(crowdWasRight);
  } else {
    getDb().prepare(`INSERT INTO crowd_calibration (category, total_polls, correct) VALUES ('general', 1, ?)`).run(crowdWasRight);
  }
  return crowdWasRight;
}

export function getActivePoll(groupId) {
  return getDb().prepare(`
    SELECT * FROM polls WHERE group_id = ? AND resolved = 0
    ORDER BY posted_at DESC LIMIT 1
  `).get(String(groupId));
}

export function getCrowdCalibration() {
  return getDb().prepare(`
    SELECT
      c.total_polls,
      c.correct,
      CASE WHEN c.total_polls > 0
        THEN ROUND(CAST(c.correct AS REAL) / c.total_polls * 100, 1)
        ELSE 0
      END AS accuracy_pct,
      (SELECT COUNT(*) FROM polls WHERE resolved = 0) AS active_polls,
      (SELECT COALESCE(AVG(votes_yes + votes_no + votes_unsure), 0) FROM polls WHERE resolved = 1) AS avg_votes_per_poll
    FROM crowd_calibration c WHERE c.category = 'general'
  `).get();
}

export function getRecentPolls(limit = 5) {
  return getDb().prepare("SELECT * FROM polls ORDER BY posted_at DESC LIMIT ?").all(limit);
}
