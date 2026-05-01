import { getPool } from "../db/database.js";
import { getWalletAssets } from "../bayse/client.js";
import { decrypt } from "../utils/encryption.js";

const PLATFORM_FEE_PCT   = parseFloat(process.env.PLATFORM_FEE_PCT   || "0.03"); // 3% of winnings
const MAX_BALANCE_PCT    = parseFloat(process.env.MAX_BALANCE_PCT     || "0.60"); // max 60% of balance per trade
const DAILY_LOSS_LIMIT   = parseFloat(process.env.DAILY_LOSS_LIMIT    || "0.30"); // stop if 30% of balance lost today
const BTC_MIN_CONFIDENCE = parseFloat(process.env.BTC_MIN_CONFIDENCE  || "0.72"); // BTC 15m must be this confident
const MIN_MARKET_PRICE   = parseFloat(process.env.MIN_MARKET_PRICE    || "0.25"); // skip YES < 25¢
const MAX_MARKET_PRICE   = parseFloat(process.env.MAX_MARKET_PRICE    || "0.75"); // skip YES > 75¢

// In-memory daily loss tracker — resets at midnight
const dailyLoss = new Map(); // chatId → { date: "YYYY-MM-DD", loss: number, startBalance: number }

function todayStr() {
  return new Date().toISOString().split("T")[0];
}

// Get or reset daily loss tracker for a user
function getDailyLossRecord(chatId, currentBalance) {
  const today  = todayStr();
  const record = dailyLoss.get(chatId);

  if (!record || record.date !== today) {
    const fresh = { date: today, loss: 0, startBalance: currentBalance };
    dailyLoss.set(chatId, fresh);
    return fresh;
  }
  return record;
}

export function recordLoss(chatId, amount) {
  const record = dailyLoss.get(chatId);
  if (record && record.date === todayStr()) {
    record.loss += Math.abs(amount);
  }
}

export function recordWin(chatId, amount) {
  // Wins reduce the day's loss tally
  const record = dailyLoss.get(chatId);
  if (record && record.date === todayStr()) {
    record.loss = Math.max(0, record.loss - Math.abs(amount));
  }
}

// Fetch user's available balance from Bayse
async function fetchBalance(user) {
  try {
    const pubKey  = decrypt(user.bayse_pub_key);
    const secKey  = decrypt(user.bayse_sec_key);
    const assets  = await getWalletAssets(pubKey, secKey);
    const currency = user.currency || "USD";

    // Assets response — try common shapes
    const list = assets?.assets || assets?.data || assets || [];
    const asset = Array.isArray(list)
      ? list.find(a =>
          (a.currency || a.symbol || a.asset || "").toUpperCase() === currency.toUpperCase()
        )
      : null;

    const balance = parseFloat(
      asset?.available ?? asset?.balance ?? asset?.amount ?? 0
    );

    console.log(`[RiskManager] Balance for ${user.chat_id}: ${currency} ${balance}`);
    return balance;
  } catch (err) {
    console.warn(`[RiskManager] Balance fetch failed for ${user.chat_id}: ${err.message}`);
    return null; // null means we couldn't fetch — use conservative fallback
  }
}

// Main risk check — called before every trade
// Returns { allowed: bool, amount: number, reason: string }
export async function checkRisk(user, match, decision, signals) {
  const currency = user.currency || "USD";
  const minTrade = currency === "NGN" ? 100 : 1;

  // 1. Market quality filter — skip extreme prices
  const market   = match.market;
  const yesPrice = market.outcome1Price || 0.5;
  const noPrice  = market.outcome2Price || 0.5;
  const tradePrice = decision.direction === "bullish" ? yesPrice : noPrice;

  if (tradePrice < MIN_MARKET_PRICE || tradePrice > MAX_MARKET_PRICE) {
    return {
      allowed: false,
      reason:  `Market price ${(tradePrice * 100).toFixed(0)}¢ outside safe range (${(MIN_MARKET_PRICE * 100).toFixed(0)}¢–${(MAX_MARKET_PRICE * 100).toFixed(0)}¢) — edge is gone`,
    };
  }

  // 2. BTC market confidence floor
  const isBtcMarket = (match.event.title || "").toLowerCase().includes("bitcoin") ||
                      (match.event.title || "").toLowerCase().includes("btc");

  if (isBtcMarket && signals.btc15m?.score < BTC_MIN_CONFIDENCE) {
    return {
      allowed: false,
      reason:  `BTC 15m confidence ${(signals.btc15m.score * 100).toFixed(0)}% below floor ${(BTC_MIN_CONFIDENCE * 100).toFixed(0)}% — skipping`,
    };
  }

  // 3. Fetch live balance
  const balance = await fetchBalance(user);

  if (balance !== null && balance < minTrade) {
    return {
      allowed: false,
      reason:  `Insufficient balance — ${currency} ${balance.toFixed(2)} available`,
    };
  }

  // 4. Daily loss limit check
  if (balance !== null) {
    const record      = getDailyLossRecord(user.chat_id, balance);
    const lossLimit   = record.startBalance * DAILY_LOSS_LIMIT;

    if (record.loss >= lossLimit) {
      return {
        allowed: false,
        reason:  `Daily loss limit reached — lost ${currency} ${record.loss.toFixed(2)} today (limit: ${currency} ${lossLimit.toFixed(2)}) — engine paused until tomorrow`,
        pauseEngine: true,
      };
    }
  }

  // 5. Balance-aware position sizing — never bet more than 60% of balance per trade
  let amount = decision.amount;

  if (balance !== null) {
    const maxAllowed = balance * MAX_BALANCE_PCT;
    if (amount > maxAllowed) {
      amount = maxAllowed;
      console.log(`[RiskManager] Amount capped at ${MAX_BALANCE_PCT * 100}% of balance: ${currency} ${amount.toFixed(2)}`);
    }
  }

  // Enforce minimum
  if (currency === "NGN") {
    amount = Math.max(Math.round(amount), 100);
  } else {
    amount = Math.max(parseFloat(amount.toFixed(2)), 1);
  }

  return {
    allowed: true,
    amount,
    balance,
  };
}

// Calculate platform fee on a resolved trade
// Returns { userPnl, platformFee }
export function calculateFee(pnl, amount) {
  if (pnl <= 0) {
    // No fee on losses — only take from wins
    return { userPnl: pnl, platformFee: 0 };
  }

  const platformFee = parseFloat((pnl * PLATFORM_FEE_PCT).toFixed(2));
  const userPnl     = parseFloat((pnl - platformFee).toFixed(2));

  return { userPnl, platformFee };
}

export { PLATFORM_FEE_PCT, MAX_BALANCE_PCT, DAILY_LOSS_LIMIT, BTC_MIN_CONFIDENCE };
