import { getWalletAssets } from "../bayse/client.js";
import { decrypt } from "../utils/encryption.js";

const PLATFORM_FEE_PCT = Number(process.env.PLATFORM_FEE_PCT ?? 0.03);
const MAX_BALANCE_PCT  = Number(process.env.MAX_BALANCE_PCT ?? 0.60);
const DAILY_LOSS_LIMIT = Number(process.env.DAILY_LOSS_LIMIT ?? 0.30);

const MIN_MARKET_PRICE = Number(process.env.MIN_MARKET_PRICE ?? 0.20);
const MAX_MARKET_PRICE = Number(process.env.MAX_MARKET_PRICE ?? 0.80);

const dailyLoss = new Map();

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getOrCreateDaily(chatId, balance) {
  const key = todayKey();
  const existing = dailyLoss.get(chatId);

  if (!existing || existing.date !== key) {
    const fresh = {
      date: key,
      loss: 0,
      startBalance: Number(balance || 0),
    };
    dailyLoss.set(chatId, fresh);
    return fresh;
  }

  return existing;
}

export function recordLoss(chatId, amount) {
  const rec = dailyLoss.get(chatId);
  if (!rec || rec.date !== todayKey()) return;
  rec.loss += Math.abs(Number(amount || 0));
}

export function recordWin(chatId, amount) {
  const rec = dailyLoss.get(chatId);
  if (!rec || rec.date !== todayKey()) return;
  rec.loss = Math.max(0, rec.loss - Math.abs(Number(amount || 0)));
}

async function fetchBalance(user) {
  try {
    const pub = decrypt(user.bayse_pub_key);
    const sec = decrypt(user.bayse_sec_key);

    const assets = await getWalletAssets(pub, sec);

    const currency = (user.currency || "USD").toUpperCase();
    const list = assets?.assets || assets?.data || assets || [];

    if (!Array.isArray(list)) return null;

    const asset = list.find(a =>
      (a.currency || a.symbol || a.asset || "").toUpperCase() === currency
    );

    const balance = Number(
      asset?.available ?? asset?.balance ?? asset?.amount ?? 0
    );

    console.log(`[Risk] Balance ${user.chat_id}: ${currency} ${balance}`);
    return Number.isFinite(balance) ? balance : null;
  } catch (e) {
    console.warn(`[Risk] balance fetch failed: ${e.message}`);
    return null;
  }
}

function getBtcFloor(threshold) {
  return Math.max(threshold + 0.10, 0.60);
}

export async function checkRisk(user, match, decision, signals) {
  const currency = (user.currency || "USD").toUpperCase();
  const minTrade = currency === "NGN" ? 100 : 1;

  const threshold = Number(user.threshold ?? 0.60);

  // market sanity filter
  const market = match?.market;
  const yes = Number(market?.outcome1Price ?? 0.5);
  const no  = Number(market?.outcome2Price ?? 0.5);

  const tradePrice = decision?.direction === "bullish" ? yes : no;

  if (tradePrice < MIN_MARKET_PRICE || tradePrice > MAX_MARKET_PRICE) {
    return {
      allowed: false,
      reason: `Market price ${(tradePrice * 100).toFixed(0)}¢ outside range`,
    };
  }

  // BTC gating
  const title = (match?.event?.title || "").toLowerCase();
  const isBtc = title.includes("btc") || title.includes("bitcoin");

  if (isBtc) {
    const floor = getBtcFloor(threshold);
    const btcScore = signals?.btc15m?.score ?? 0;

    if (btcScore < floor) {
      return {
        allowed: false,
        reason: `BTC score ${(btcScore * 100).toFixed(0)}% below floor ${(floor * 100).toFixed(0)}%`,
      };
    }
  }

  const balance = await fetchBalance(user);

  if (balance !== null && balance < minTrade) {
    return {
      allowed: false,
      reason: `Insufficient balance ${currency} ${balance}`,
    };
  }

  // daily loss control
  if (balance !== null) {
    const rec = getOrCreateDaily(user.chat_id, balance);
    const limit = rec.startBalance * DAILY_LOSS_LIMIT;

    if (rec.loss >= limit) {
      return {
        allowed: false,
        pauseEngine: true,
        reason: `Daily loss limit hit ${rec.loss.toFixed(2)}`,
      };
    }
  }

  // cap exposure
  let amount = Number(decision.amount || 0);

  if (balance !== null) {
    const maxAllowed = balance * MAX_BALANCE_PCT;
    amount = Math.min(amount, maxAllowed);
  }

  amount = currency === "NGN"
    ? Math.max(Math.round(amount), 100)
    : Math.max(Number(amount.toFixed(2)), 1);

  return {
    allowed: true,
    amount,
    balance,
  };
}

export function calculateFee(pnl) {
  const p = Number(pnl || 0);

  if (p <= 0) {
    return { userPnl: p, platformFee: 0 };
  }

  const fee = Number((p * PLATFORM_FEE_PCT).toFixed(2));

  return {
    userPnl: Number((p - fee).toFixed(2)),
    platformFee: fee,
  };
}

export {
  PLATFORM_FEE_PCT,
  MAX_BALANCE_PCT,
  DAILY_LOSS_LIMIT,
};
