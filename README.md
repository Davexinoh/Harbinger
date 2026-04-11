# Harbinger

> *The market moves. We saw it coming.*

Harbinger is an autonomous signal-to-trade engine for [Bayse](https://bayse.markets) prediction markets. It watches the world — crypto momentum, football form, live news — and trades when signals converge. No manual input. No guesswork. The engine decides.

Built on top of Bayse's public API, Harbinger is the first prediction market bot where the community is a live signal source, not just an audience. When signals heat up, the crowd votes. Those votes feed directly into the engine's decision.

---

## How It Works

Every 60 seconds, three signal workers run in parallel:

**Crypto momentum** watches BTC, ETH, and SOL on CoinGecko. It measures price velocity over 1 hour and 24 hours, weighs volume-to-market-cap ratios, and produces a directional confidence score. A 5% move in an hour is extreme. The engine knows that.

**Football form** pulls upcoming fixtures from African leagues and global competitions via API-Football. It scores each match by comparing the recent win/draw/loss record of both teams. The bigger the form gap, the stronger the signal. If one team has won 5 straight and the market still shows it as a coin flip — that's an inefficiency. Harbinger sees it.

**News sentiment** reads live RSS feeds from BBC Sport Africa, CoinDesk, CoinTelegraph, and Premium Times NG. It filters for market-relevant headlines and scores them against a vocabulary of bullish and bearish signals. Only fresh headlines — within the last two hours — count.

These three signals are weighted and combined into a single composite score. When that score crosses a user-defined confidence threshold, the engine finds the best matching open market on Bayse, gets a live quote, and places the trade.

---

## The 4th Signal — Community Wisdom

This is what makes Harbinger different from every other bot.

When the composite score enters the warmup zone — strong enough to be interesting, not yet strong enough to trade — Harbinger posts a poll to every Telegram group it's in. The question is generated from the live signal context: the event title, the engine's directional read, and the current confidence level.

The crowd votes. YES, NO, or Too Early to Call.

Those votes become a fourth signal, weighted at 18% of the composite. Strong crowd agreement boosts the trade. Strong crowd disagreement can stop it entirely. And over time, the engine tracks how accurate the crowd has been — building a calibration record that gets richer with every resolved market.

The crowd isn't commentary. The crowd is signal.

---

## Signals → Decision → Trade

The decision gate combines all four signals and checks for consensus. At least 3 out of 4 must agree on direction before the engine acts. If the crowd has voted strongly against the algorithmic signals, the engine stands down regardless of the composite score.

Position sizing scales with conviction. At threshold, the engine bets the minimum. As confidence climbs toward 95%, it scales toward the user's maximum. A strong crowd agreement — 10 or more votes, 70%+ consensus — adds a small boost on top.

Every trade fires against an AMM market on Bayse. Before any order is placed, the engine requests a live quote and sanity-checks the expected price. If the market is already priced at an extreme, the trade is skipped. Never trade blind.

---

## What Users See

Harbinger is entirely Telegram-native. There's no website to log into, no dashboard to check. Everything happens in the chat.

Users connect their Bayse API keys through a guided flow. Keys are encrypted with AES-256 before storage and never logged. Once connected, users set their confidence threshold and maximum trade size, type `/run`, and the engine takes over.

From that point, Harbinger messages the user every time it fires a trade — what it traded, why, which signal led, the entry price, and the full signal breakdown. It also messages when signals are warming up, so users feel the engine thinking before it acts.

Groups get broadcast updates whenever the composite score is elevated. They get crowd polls when signals are hot. Over time, a group running Harbinger becomes a live prediction market intelligence feed.

---

## Commands

`/start` `/connect` `/setup` `/run` `/pause` `/resume` `/stop` `/status` `/signals` `/trades` `/pnl` `/markets` `/hot` `/limit` `/threshold` `/crowdiq` `/disconnect`

---

## Stack

Node.js · Express · SQLite · Telegram Bot API · Bayse Markets API · CoinGecko · API-Football · RSS

Deployed on Render. No external database. No paid AI APIs. Everything runs on free-tier infrastructure.

---

## Built By

[@dontfadedave](https://twitter.com/dontfadedave) — Davexinoh Labs  
Powered by [Bayse Markets](https://bayse.markets)
