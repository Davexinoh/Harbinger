// Determines whether signals are strong enough to fire a trade
// and how much to bet — now includes crowd as a 4th signal

export function shouldTrade(signals, userConfig) {
  const { composite, crypto, sports, sentiment, crowd } = signals;
  const threshold = userConfig.threshold ||
    parseFloat(process.env.DEFAULT_CONFIDENCE_THRESHOLD) || 0.72;

  // Direction consensus check across all 4 signals
  const bullishVotes = [
    crypto.direction    === "UP"      || crypto.direction    === "bullish",
    sports.direction    === "home"    || sports.direction    === "bullish",
    sentiment.direction === "bullish",
    crowd.direction     === "YES",
  ].filter(Boolean).length;

  // Need at least 3/4 signals agreeing (crowd inclusion makes this tighter)
  const signalsAgree = bullishVotes >= 3 || bullishVotes <= 1;

  if (!signalsAgree) {
    return {
      fire: false,
      reason: `Signals split (${bullishVotes}/4 bullish) — no strong consensus`,
      composite,
      threshold,
      crowdVotes: crowd.totalVotes,
    };
  }

  // If crowd has voted and strongly disagrees with algo signals, dampen
  const algoBullish = bullishVotes >= 3;
  const crowdDisagrees =
    crowd.totalVotes >= 5 &&
    ((algoBullish && crowd.score < 0.35) || (!algoBullish && crowd.score > 0.65));

  if (crowdDisagrees) {
    return {
      fire: false,
      reason: `Crowd strongly disagrees (${(crowd.score * 100).toFixed(0)}% YES, ${crowd.totalVotes} votes) — standing down`,
      composite,
      threshold,
      crowdVotes: crowd.totalVotes,
    };
  }

  if (composite < threshold) {
    return {
      fire: false,
      reason: `Composite ${composite.toFixed(3)} below threshold ${threshold}`,
      composite,
      threshold,
      crowdVotes: crowd.totalVotes,
    };
  }

  // Conviction-scaled position sizing
  const maxAmount = userConfig.max_trade_usd ||
    parseFloat(process.env.DEFAULT_MAX_TRADE_USD) || 5;
  const scaleRatio  = Math.min((composite - threshold) / (0.95 - threshold), 1);
  const minAmount   = maxAmount * 0.3;
  let   amount      = minAmount + (maxAmount - minAmount) * scaleRatio;

  // Crowd boost: if 10+ votes and >70% YES, add up to 15% to position size
  if (crowd.totalVotes >= 10 && crowd.score >= 0.70) {
    const crowdBoost = (crowd.score - 0.70) / 0.30 * 0.15;
    amount = Math.min(amount * (1 + crowdBoost), maxAmount);
  }

  return {
    fire: true,
    amount: parseFloat(amount.toFixed(2)),
    composite,
    threshold,
    direction: bullishVotes >= 3 ? "bullish" : "bearish",
    crowdVotes: crowd.totalVotes,
    crowdScore: crowd.score,
    reason:
      `Composite ${composite.toFixed(3)} ≥ threshold ${threshold} | ` +
      `${bullishVotes}/4 signals agree | ` +
      `Crowd: ${crowd.totalVotes > 0 ? `${(crowd.score * 100).toFixed(0)}% YES (${crowd.totalVotes} votes)` : "no votes yet"}`,
  };
}
