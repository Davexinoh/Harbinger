export function shouldTrade(signals, userConfig) {
  const { composite, crypto, sports, sentiment, crowd } = signals;
  const threshold = userConfig.threshold ||
    parseFloat(process.env.DEFAULT_CONFIDENCE_THRESHOLD) || 0.65;

  // Crowd abstains if no votes — only counts when people have actually voted
  const crowdHasVotes   = (crowd.totalVotes || 0) >= 3;
  const crowdIsBullish  = crowdHasVotes && crowd.direction === "YES";
  const crowdIsBearish  = crowdHasVotes && crowd.direction === "NO";

  // Active signals: only count crowd when it has votes
  const activeBullish = [
    crypto.direction    === "UP"   || crypto.direction    === "bullish",
    sports.direction    === "home" || sports.direction    === "bullish",
    sentiment.direction === "bullish",
    crowdIsBullish,
  ].filter(Boolean).length;

  const activeBearish = [
    crypto.direction    === "DOWN"    || crypto.direction    === "bearish",
    sports.direction    === "away"    || sports.direction    === "bearish",
    sentiment.direction === "bearish",
    crowdIsBearish,
  ].filter(Boolean).length;

  // When crowd has no votes, we only need 2/3 algo signals to agree
  const requiredVotes = crowdHasVotes ? 3 : 2;
  const signalsAgree  = activeBullish >= requiredVotes || activeBearish >= requiredVotes;

  if (!signalsAgree) {
    return {
      fire: false,
      reason: `Signals split — ${activeBullish} bullish / ${activeBearish} bearish (need ${requiredVotes} to agree)`,
      composite,
      threshold,
    };
  }

  // Crowd veto: if crowd has strong votes against the algo direction, stand down
  const algoBullish = activeBullish >= activeBearish;
  const crowdVeto =
    crowdHasVotes &&
    ((algoBullish && crowd.score < 0.30) || (!algoBullish && crowd.score > 0.70));

  if (crowdVeto) {
    return {
      fire: false,
      reason: `Crowd vetoes trade — ${(crowd.score * 100).toFixed(0)}% YES with ${crowd.totalVotes} votes`,
      composite,
      threshold,
    };
  }

  if (composite < threshold) {
    return {
      fire: false,
      reason: `Composite ${composite.toFixed(3)} below threshold ${threshold}`,
      composite,
      threshold,
    };
  }

  // Position sizing scaled by conviction
  const maxAmount  = userConfig.max_trade_usd || parseFloat(process.env.DEFAULT_MAX_TRADE_USD) || 5;
  const scaleRatio = Math.min((composite - threshold) / (0.95 - threshold), 1);
  const minAmount  = maxAmount * 0.3;
  let   amount     = minAmount + (maxAmount - minAmount) * scaleRatio;

  // Crowd boost when strongly aligned
  if (crowdHasVotes && crowd.totalVotes >= 10 && crowd.score >= 0.70) {
    const boost = (crowd.score - 0.70) / 0.30 * 0.15;
    amount = Math.min(amount * (1 + boost), maxAmount);
  }

  const direction = algoBullish ? "bullish" : "bearish";

  return {
    fire: true,
    amount: parseFloat(amount.toFixed(2)),
    composite,
    threshold,
    direction,
    crowdVotes: crowd.totalVotes || 0,
    crowdScore: crowd.score,
    reason:
      `Composite ${composite.toFixed(3)} ≥ ${threshold} | ` +
      `${activeBullish}B/${activeBearish}Be | ` +
      `Crowd: ${crowdHasVotes ? `${(crowd.score * 100).toFixed(0)}% YES (${crowd.totalVotes} votes)` : "no votes — abstained"}`,
  };
}
