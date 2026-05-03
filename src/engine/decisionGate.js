export function shouldTrade(signals, userConfig) {
  const { composite, crypto, sports, sentiment, btc15m } = signals;

  const threshold = Number(userConfig.threshold);
  const safeThreshold = Number.isFinite(threshold) ? threshold : 0.6;

  if (composite < safeThreshold) {
    return {
      fire: false,
      reason: `Composite ${composite.toFixed(3)} below threshold ${safeThreshold}`,
      composite,
      threshold: safeThreshold,
    };
  }

  const signalSet = [
    crypto?.direction,
    sports?.direction,
    sentiment?.direction,
    btc15m?.direction,
  ].filter(Boolean);

  const bullish = signalSet.filter(
    d => d === "UP" || d === "bullish" || d === "YES" || d === "home"
  ).length;

  const bearish = signalSet.length - bullish;

  if (bullish < 2 && bearish < 2) {
    return {
      fire: false,
      reason: `Signals split — ${bullish}B/${bearish}Be`,
      composite,
      threshold: safeThreshold,
    };
  }

  const maxAmountRaw = Number(userConfig.max_trade_usd);
  const maxAmount = Number.isFinite(maxAmountRaw) ? maxAmountRaw : 500;

  const scaleRatio = Math.min(
    (composite - safeThreshold) / (0.95 - safeThreshold),
    1
  );

  const amount = maxAmount * (0.3 + 0.7 * scaleRatio);

  return {
    fire: true,
    amount: Number(amount.toFixed(2)),
    composite,
    threshold: safeThreshold,
    direction: bullish >= bearish ? "bullish" : "bearish",
    reason: `Composite ${composite.toFixed(3)} ≥ ${safeThreshold} | ${bullish}B/${bearish}Be`,
  };
}
