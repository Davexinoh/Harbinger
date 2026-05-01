import { getWalletAssets } from "../bayse/client.js";
import { decrypt } from "../utils/encryption.js";

const PLATFORM_FEE_PCT = parseFloat(process.env.PLATFORM_FEE_PCT  || "0.03");
const MAX_BALANCE_PCT  = parseFloat(process.env.MAX_BALANCE_PCT    || "0.60");
const DAILY_LOSS_LIMIT = parseFloat(process.env.DAILY_LOSS_LIMIT   || "0.30");
const MIN_MARKET_PRICE = parseFloat(process.env.MIN_MARKET_PRICE   || "0.20");
const MAX_MARKET_PRICE = parseFloat(process.env.MAX_MARKET_PRICE   || "0.80");

// BTC confidence floor scales with user threshold
// If user sets 0.5 threshold they accept risk — floor = threshold + 0.10
// If user sets 0.72+ threshold — floor = 0.72
function getBtcFloor(userThreshold) {
  return Math.max(userThreshold + 0.10, 0.60);
}

const dailyLoss = new Map();

function todayStr() {
  return new Date().toISOString().split("T")[0];
}

function getDailyRecord(chatId, balance) {
  const today  = todayStr();
  const record = dailyLoss.get(chatId);
  if (!record || record.date !== today) {
    const fresh = { date: today, loss: 0, startBalance: balance };
    dailyLoss.set(chatId, fresh);
    return fresh;
  }
  return record;
}

export function recordLoss(chatId, amount) {
  const r = dailyLoss.get(chatId);
  if (r && r.date === todayStr()) r.loss += Math.abs(amount);
}

export function recordWin(chatId, amount) {
  const r = dailyLoss.get(chatId);
  if (r && r.date === todayStr()) r.loss = Math.max(0, r.loss - Math.abs(amount));
}

async function fetchBalance(user) {
  try {
    const pubKey   = decrypt(user.bayse_pub_key);
    const secKey   = decrypt(user.bayse_sec_key);
    const assets   = await getWalletAssets(pubKey, secKey);
    const currency = user.currency || "USD";
    const list     = assets?.assets || assets?.data || assets || [];
    const asset    = Array.isArray(list)
      ? list.find(a => (a.currency || a.symbol || a.asset || "").toUpperCase() === currency.toUpperCase())
      : null;
    const balance = parseFloat(asset?.available ?? asset?.balance ?? asset?.amount ?? 0);
    console.log(`[Risk] Balance ${user.chat_id}: ${currency} ${balance}`);
    return balance;
  } catch (err) {
    console.warn(`[Risk] Balance fetch failed: ${err.message}`);
    return null;
  }
}

export async function checkRisk(user, match, decision, signals) {
  const currency  = user.currency || "USD";
  const minTrade  = currency === "NGN" ? 100 : 1;
  const threshold = user.threshold || 0.60;

  // 1. Market quality filter
  const market     = match.market;
  const yesPrice   = market.outcome1Price || 0.5;
  const noPrice    = market.outcome2Price || 0.5;
  const tradePrice = decision.direction === "bullish" ? yesPrice : noPrice;

  if (tradePrice < MIN_MARKET_PRICE || tradePrice > MAX_MARKET_PRICE) {
    return {
      allowed: false,
      reason:  `Market price ${(tradePrice * 100).toFixed(0)}¢ outside safe range — edge gone`,
    };
  }

  // 2. BTC confidence floor — scales with user threshold
  const eventTitle = (match.event.title || "").toLowerCase();
  const isBtcMarket = eventTitle.includes("bitcoin") || eventTitle.includes("btc");
  const btcFloor    = getBtcFloor(threshold);

  if (isBtcMarket && signals.btc15m?.score < btcFloor) {
    return {
      allowed: false,
      reason:  `BTC 15m score ${(signals.btc15m.score * 100).toFixed(0)}% below floor ${(btcFloor * 100).toFixed(0)}%`,
    };
  }

  // 3. Fetch balance
  const balance = await fetchBalance(user);

  if (balance !== null && balance < minTrade) {
    return {
      allowed: false,
      reason:  `Insufficient balance — ${currency} ${balance.toFixed(2)}`,
    };
  }

  // 4. Daily loss limit
  if (balance !== null) {
    const record    = getDailyRecord(user.chat_id, balance);
    const lossLimit = record.startBalance * DAILY_LOSS_LIMIT;
    if (record.loss >= lossLimit) {
      return {
        allowed:     false,
        reason:      `Daily loss limit hit — ${currency} ${record.loss.toFixed(2)} lost today`,
        pauseEngine: true,
      };
    }
  }

  // 5. Cap at 60% of balance
  let amount = decision.amount;
  if (balance !== null) {
    const maxAllowed = balance * MAX_BALANCE_PCT;
    if (amount > maxAllowed) {
      amount = maxAllowed;
      console.log(`[Risk] Capped to ${(MAX_BALANCE_PCT * 100).toFixed(0)}% of balance: ${currency} ${amount.toFixed(2)}`);
    }
  }

  amount = currency === "NGN"
    ? Math.max(Math.round(amount), 100)
    : Math.max(parseFloat(amount.toFixed(2)), 1);

  return { allowed: true, amount, balance };
}

export function calculateFee(pnl) {
  if (pnl <= 0) return { userPnl: pnl, platformFee: 0 };
  const fee    = parseFloat((pnl * PLATFORM_FEE_PCT).toFixed(2));
  const userPnl = parseFloat((pnl - fee).toFixed(2));
  return { userPnl, platformFee: fee };
}

export { PLATFORM_FEE_PCT, MAX_BALANCE_PCT, DAILY_LOSS_LIMIT };
