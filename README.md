# Harbinger

> *The market moves. We saw it coming.*

Harbinger is an autonomous signal-to-trade engine for [Bayse](https://bayse.markets) prediction markets. It watches crypto momentum, order flow, and live news, and trades when signals converge. No manual input. No guesswork. The engine decides.

---

## How It Works

Every 60 seconds, four signal workers run in parallel.

**Crypto momentum** (35%) reads BTC, ETH, and SOL from Binance. For each symbol it compares the last hour against the previous 24 hours and casts a bull or bear vote. Three symbols agreeing is a strong read; a split is noise.

**BTC 15m** (30%) pulls thirty 15-minute candles for BTCUSDT and computes a 14-period RSI alongside 5-candle price momentum and volume against its 10-candle mean. Oversold and turning up is the high-conviction case. So is overbought and turning down. Thin volume pulls the score back toward neutral.

**Market pressure** (20%) reads Bayse's own order book — the average YES price across up to ten open CLOB crypto markets. When the book leans, that lean is information.

**News sentiment** (15%) scores live headlines from CoinDesk, Cointelegraph, Nairametrics, and BBC Sport Africa against a bullish/bearish vocabulary, weighted by source. Feeds get four seconds to answer or they're skipped.

The four scores combine into one weighted composite between 0 and 1. Direction is decided by majority vote across the four workers. Any worker that fails degrades to a neutral 0.5 rather than stalling the tick.

---

## Signals → Decision → Trade

When the composite crosses the user's confidence threshold, the engine looks for a market worth taking.

It considers CLOB markets only — AMM events are excluded outright — priced between 10¢ and 90¢, skipping any event where the user already holds an open position. Each candidate is scored on **edge**: how far the market's price sits from 50¢ in the direction the signal points. A signal reading UP against a market pricing YES at 30¢ is edge. The same signal against YES at 85¢ is not, and the engine passes. Nothing is entered below 5¢ of edge, regardless of how strong the composite is. Bitcoin short-horizon markets get a ranking bonus.

Position size scales with conviction, from half the user's maximum at threshold toward the full amount as the composite approaches 1, with a ₦100 floor. Orders are placed as NGN market orders. A five-minute cooldown separates trades per user.

**The sniper** runs a tighter loop alongside the main engine, scanning every 10 seconds for freshly opened *Bitcoin Up or Down* markets still priced between 42¢ and 58¢. When the BTC 15m signal alone clears 0.56, it fires on those directly — the edge in a 15-minute market decays too fast to wait for the next 60-second tick.

---

## What Users See

Harbinger is entirely Telegram-native. No website, no dashboard.

Users connect their Bayse API keys through a guided flow. Keys are encrypted with AES-256-CBC before storage and never logged. Once connected, users set a confidence threshold and maximum trade size, type `/run`, and the engine takes over — messaging on every trade with the market, the side, the size, and the signal breakdown behind it.

---

## Commands

`/start` `/connect` `/disconnect` `/setup` `/run` `/pause` `/resume` `/stop` `/status` `/signals` `/category` `/markets` `/trades` `/pnl` `/cancel`

---

## Stack

Node.js 22 · Express · PostgreSQL · Telegram Bot API · Bayse Markets API · Binance public API · RSS

Deployed on Railway as a single always-on worker. No paid AI APIs.

### Running locally

```bash
npm install
cp .env.example .env    # fill in TELEGRAM_BOT_TOKEN, DATABASE_URL, ENCRYPTION_KEY
npm start
```

Verify all four signal sources resolve before enabling live trading:

```bash
npm run smoke -- <bayse_public_key>
```

---

## Current Limitations

Worth stating plainly, since this engine moves real money:

- **Risk limits in `.env.example` are not wired up.** Per-trade sizing lives as constants in `src/engine/executor.js`. There is no daily-loss or balance-percentage enforcement in code yet.
- **Cooldown and dedupe state is in-memory.** A restart clears the five-minute trade gap and the sniper's already-hit set, so a crash loop can trade more often than intended.
- **Exactly one instance may run per bot token.** Telegram allows a single `getUpdates` consumer, so a second replica produces a permanent 409 conflict.

## Roadmap

- **Community signal.** Crowd polls posted to Telegram groups during the warmup zone, feeding group consensus back into the composite as a fifth input, with a calibration record tracked over time. Designed, not yet built.
- Persist cooldown and position state to Postgres.
- Wire the risk limits in `.env.example` into the engine.

---

## Built By

[@dontfadedave](https://twitter.com/dontfadedave) — Davexinoh Labs
Powered by [Bayse Markets](https://bayse.markets)
