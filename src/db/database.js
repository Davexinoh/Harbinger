import pg from "pg";
const { Pool } = pg;

let pool;
export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    pool.on("error", err => console.error("[DB] Pool error:", err.message));
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
        threshold          REAL    NOT NULL DEFAULT 0.50,
        max_trade_amount   REAL    NOT NULL DEFAULT 200,
        preferred_category TEXT    NOT NULL DEFAULT 'all',
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
        signal_source  TEXT,
        side           TEXT    NOT NULL DEFAULT 'BUY',
        outcome        TEXT    NOT NULL,
        amount         REAL    NOT NULL,
        fill_price     REAL,
        status         TEXT    NOT NULL DEFAULT 'open',
        pnl            REAL,
        bayse_order_id TEXT,
        executed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at    TIMESTAMPTZ
      );
    `);

    // Live migrations
    const migrations = [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_category TEXT NOT NULL DEFAULT 'all'`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS max_trade_amount REAL NOT NULL DEFAULT 200`,
      `ALTER TABLE trades ADD COLUMN IF NOT EXISTS outcome_label TEXT`,
      `ALTER TABLE trades ADD COLUMN IF NOT EXISTS bayse_order_id TEXT`,
      `ALTER TABLE trades ADD COLUMN IF NOT EXISTS fill_price REAL`,
      // Update existing users threshold to 0.50 if still at old default 0.60
      `UPDATE users SET threshold = 0.50 WHERE threshold = 0.60`,
    ];

    for (const m of migrations) {
      try { await client.query(m); } catch (_) {}
    }

    console.log("[DB] Schema ready");
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
  const r = await getPool().query(
    "SELECT * FROM users WHERE chat_id=$1",
    [String(chatId)]
  );
  return r.rows[0] || null;
}

export async function updateUser(chatId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const set  = keys.map((k, i) => `${k}=$${i + 1}`).join(", ");
  await getPool().query(
    `UPDATE users SET ${set} WHERE chat_id=$${keys.length + 1}`,
    [...keys.map(k => fields[k]), String(chatId)]
  );
}

export async function getActiveUsers() {
  const r = await getPool().query(`
    SELECT * FROM users
    WHERE engine_active = 1
      AND bayse_pub_key IS NOT NULL
      AND bayse_sec_key IS NOT NULL
  `);
  return r.rows;
}

// ─── Trades ───────────────────────────────────────────────────────────────────

export async function insertTrade(t) {
  const r = await getPool().query(`
    INSERT INTO trades
      (chat_id, event_id, market_id, event_title, outcome_label,
       signal_source, side, outcome, amount, fill_price, status, bayse_order_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING id
  `, [
    t.chat_id, t.event_id, t.market_id, t.event_title,
    t.outcome_label || null, t.signal_source || null,
    t.side || "BUY", t.outcome, t.amount,
    t.fill_price || null, "open", t.bayse_order_id || null,
  ]);
  return r.rows[0];
}

export async function updateTrade(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const set  = keys.map((k, i) => `${k}=$${i + 1}`).join(", ");
  await getPool().query(
    `UPDATE trades SET ${set} WHERE id=$${keys.length + 1}`,
    [...keys.map(k => fields[k]), id]
  );
}

export async function getRecentTrades(chatId, limit = 10) {
  const r = await getPool().query(
    "SELECT * FROM trades WHERE chat_id=$1 ORDER BY executed_at DESC LIMIT $2",
    [String(chatId), limit]
  );
  return r.rows;
}

export async function getOpenTrades() {
  const r = await getPool().query(`
    SELECT t.*, u.bayse_pub_key, u.bayse_sec_key
    FROM trades t
    JOIN users u ON u.chat_id = t.chat_id
    WHERE t.status = 'open'
      AND u.bayse_pub_key IS NOT NULL
      AND u.bayse_sec_key IS NOT NULL
    ORDER BY t.executed_at ASC
  `);
  return r.rows;
}

export async function getOpenEventIds(chatId) {
  const r = await getPool().query(
    "SELECT event_id FROM trades WHERE chat_id=$1 AND status='open'",
    [String(chatId)]
  );
  return new Set(r.rows.map(row => row.event_id));
}

export async function getPnL(chatId) {
  const r = await getPool().query(`
    SELECT
      COUNT(*)::int                                       AS total,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)::int     AS wins,
      SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END)::int    AS losses,
      COALESCE(SUM(pnl), 0)                              AS net
    FROM trades
    WHERE chat_id=$1 AND status='resolved'
  `, [String(chatId)]);
  return r.rows[0];
}
