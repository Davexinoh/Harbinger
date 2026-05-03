export function shouldTrade(signals, userConfig) {
  const { composite, crypto, sports, sentiment, btc15m } = signals;
  const threshold = parseFloat(userConfig.threshold) || 0.60;

  if (composite < threshold) {
    return { fire: false, reason: `Composite ${composite.toFixed(3)} below threshold ${threshold}`, composite, threshold };
  }

  // Need 2 of 4 signals to agree on direction
  const bullish = [
    crypto.direction    === "UP"   || crypto.direction    === "bullish",
    sports.direction    === "YES"  || sports.direction    === "home",
    sentiment.direction === "bullish",
    btc15m?.direction   === "UP",
  ].filter(Boolean).length;

  const bearish = 4 - bullish;
  if (bullish < 2 && bearish < 2) {
    return { fire: false, reason: `Signals split — ${bullish}B/${bearish}Be`, composite, threshold };
  }

  const maxAmount  = parseFloat(userConfig.max_trade_usd) || 5;
  const scaleRatio = Math.min((composite - threshold) / (0.95 - threshold), 1);
  const amount     = maxAmount * 0.3 + maxAmount * 0.7 * scaleRatio;

  return {
    fire:      true,
    amount:    parseFloat(amount.toFixed(2)),
    composite,
    threshold,
    direction: bullish >= bearish ? "bullish" : "bearish",
    reason:    `Composite ${composite.toFixed(3)} ≥ ${threshold} | ${bullish}B/${bearish}Be`,
  };
}
