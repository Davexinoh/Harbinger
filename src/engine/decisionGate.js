// Crowd signal is intentionally excluded from trade decisions
// It's kept for group engagement only — manipulation risk is too high
// Consensus is now 3 algorithmic signals: crypto, sports/fx, sentiment

export function shouldTrade(signals, userConfig) {
  const { composite, crypto, sports, sentiment, btc15m, fx } = signals;
  const threshold = userConfig.threshold ||
    parseFloat(process.env.DEFAULT_CONFIDENCE_THRESHOLD) || 0.60;

  if (composite < threshold) {
    return {
      fire:   false,
      reason: `Composite ${composite.toFixed(3)} below threshold ${threshold}`,
      composite,
      threshold,
    };
  }

  // Direction consensus — need at least 2 of 4 algo signals to agree
  // Crypto + BTC15m count as one if they agree (same asset)
  const cryptoDir   = crypto.direction    === "UP"   || crypto.direction    === "bullish";
  const sportsDir   = sports.direction    === "YES"  || sports.direction    === "home" || sports.direction === "bullish";
  const sentDir     = sentiment.direction === "bullish";
  const btcDir      = btc15m?.direction   === "UP";
  const fxDir       = fx?.direction       === "bullish";

  const bullishCount = [cryptoDir, sportsDir, sentDir, btcDir, fxDir].filter(Boolean).length;
  const bearishCount = 5 - bullishCount;
  const signalsAgree = bullishCount >= 2 || bearishCount >= 2;

  if (!signalsAgree) {
    return {
      fire:   false,
      reason: `Signals split — ${bullishCount} bullish / ${bearishCount} bearish`,
      composite,
      threshold,
    };
  }

  // Position sizing — scales with conviction
  const maxAmount  = userConfig.max_trade_usd || parseFloat(process.env.DEFAULT_MAX_TRADE_USD) || 5;
  const scaleRatio = Math.min((composite - threshold) / (0.95 - threshold), 1);
  const minAmount  = maxAmount * 0.3;
  const amount     = minAmount + (maxAmount - minAmount) * scaleRatio;

  return {
    fire:      true,
    amount:    parseFloat(amount.toFixed(2)),
    composite,
    threshold,
    direction: bullishCount >= bearishCount ? "bullish" : "bearish",
    reason:    `Composite ${composite.toFixed(3)} ≥ ${threshold} | ${bullishCount}B/${bearishCount}Be`,
  };
}
