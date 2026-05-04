import { getWalletAssets } from "../bayse/client.js";
import { decrypt } from "../utils/encryption.js";

const PLATFORM_FEE_PCT = parseFloat(process.env.PLATFORM_FEE_PCT || "0.03");
const MAX_BALANCE_PCT = parseFloat(process.env.MAX_BALANCE_PCT || "0.60");
const DAILY_LOSS_LIMIT = parseFloat(process.env.DAILY_LOSS_LIMIT || "0.20");

const MIN_PRICE = 0.25;
const MAX_PRICE = 0.75;

const dailyRisk = new Map();

function today() {
  return new Date().toISOString().slice(0, 10);
}

function getRisk(chatId, balance) {
  const t = today();
  let r = dailyRisk.get(chatId);

  if (!r || r.date !== t) {
    r = { date: t, loss: 0, startBalance: balance || 0 };
    dailyRisk.set(chatId, r);
  }

  return r;
}

export function recordLoss(chatId, amount) {
  const r = dailyRisk.get(chatId);
  if (r && r.date === today()) {
    r.loss += Math.abs(amount);
  }
}

async function getBalance(user) {
  try {
    const pub = decrypt(user.bayse_pub_key);
    const sec = decrypt(user.bayse_sec_key);

    const assets = await getWalletAssets(pub, sec);
    const list = assets?.assets || [];

    const currency = user.currency || "USD";
    const asset = list.find(a =>
      (a.currency || "").toUpperCase() === currency.toUpperCase()
    );

    return Number(asset?.available ?? asset?.balance ?? 0);
  } catch {
    return null;
  }
}

export async function checkRisk(user, match, decision, signals) {
  const currency = user.currency || "USD";
  const minTrade = currency === "NGN" ? 100 : 1;

  const price = decision.price ?? match.market?.outcome1Price ?? null;

  if (typeof price !== "number" || price < MIN_PRICE || price > MAX_PRICE) {
    return { allowed: false, reason: "Unsafe market price" };
  }

  const balance = await getBalance(user);

  if (balance === null) {
    return { allowed: false, reason: "Balance check failed" };
  }

  if (balance < minTrade) {
    return { allowed: false, reason: "Insufficient balance" };
  }

  const risk = getRisk(user.chat_id, balance);
  const lossLimit = risk.startBalance * DAILY_LOSS_LIMIT;

  if (risk.loss >= lossLimit) {
    return {
      allowed: false,
      reason: "Daily loss limit reached",
      pauseEngine: true,
    };
  }

  let amount = decision.amount;

  const maxAllowed = balance * MAX_BALANCE_PCT;
  if (amount > maxAllowed) {
    amount = maxAllowed;
  }

  amount =
    currency === "NGN"
      ? Math.max(Math.round(amount), 100)
      : Math.max(amount, 1);

  return {
    allowed: true,
    amount,
    balance,
  };
}

export function calculateFee(pnl) {
  if (pnl <= 0) return { userPnl: pnl, platformFee: 0 };

  const fee = pnl * PLATFORM_FEE_PCT;

  return {
    userPnl: +(pnl - fee).toFixed(2),
    platformFee: +fee.toFixed(2),
  };
}
