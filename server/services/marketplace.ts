import crypto from 'node:crypto';
import P2PCalc from '../../calc.js';
import type { AppConfig } from '../config.ts';
import type { Database, DbClient } from '../db.ts';
import type { DbUserRow } from '../auth.ts';

export type KycStatus = 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED';
export type OrderStatus =
  | 'CREATED'
  | 'AWAITING_PAYMENT'
  | 'PAID_MARKED'
  | 'RELEASED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'DISPUTED';

export interface PlatformSettings {
  referenceRateSantim: number;
  commissionPercent: number;
  dailyLimitMicroUsdt: number;
  maxDisputesBeforeSuspend: number;
}

export class MarketplaceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function toBigInt(v: string | number | bigint | null | undefined): bigint {
  if (v === null || v === undefined) return 0n;
  return BigInt(v);
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function namesMatchKyc(kycFullName: string, payoutAccountName: string): boolean {
  const a = normalizeName(kycFullName);
  const b = normalizeName(payoutAccountName);
  if (!a || !b) return false;
  if (a === b) return true;
  // Also allow exact token subset match when middle name is omitted/included (at least 2 matching tokens)
  const tokensA = a.split(' ').filter(Boolean);
  const tokensB = b.split(' ').filter(Boolean);
  if (tokensA.length >= 2 && tokensB.length >= 2) {
    const common = tokensA.filter((t) => tokensB.includes(t));
    if (common.length >= 2 && (common.length === tokensA.length || common.length === tokensB.length)) {
      return true;
    }
  }
  return false;
}

export async function getSettings(db: Database | DbClient, config: AppConfig): Promise<PlatformSettings> {
  const res = await db.query<{ key: string; value: string }>(`SELECT key, value FROM settings`);
  const map = new Map<string, string>();
  for (const row of res.rows) {
    map.set(row.key, row.value);
  }
  return {
    referenceRateSantim: parseInt(map.get('reference_rate_santim') || String(config.defaultReferenceRateSantim), 10),
    commissionPercent: parseInt(map.get('commission_percent') || String(config.commissionPercent), 10),
    dailyLimitMicroUsdt: parseInt(map.get('daily_limit_micro_usdt') || String(config.defaultDailyLimitMicroUsdt), 10),
    maxDisputesBeforeSuspend: parseInt(map.get('max_disputes_before_suspend') || String(config.maxDisputesBeforeSuspend), 10),
  };
}

export async function updateSettings(
  db: Database,
  config: AppConfig,
  adminId: string,
  updates: Partial<{
    referenceRateEtb: string | number;
    commissionPercent: number;
    dailyLimitUsdt: string | number;
    maxDisputesBeforeSuspend: number;
  }>
): Promise<PlatformSettings> {
  return db.withTransaction(async (client) => {
    if (updates.referenceRateEtb !== undefined) {
      const santim = P2PCalc.parseEtbToSantim(updates.referenceRateEtb);
      if (santim <= 0n) throw new MarketplaceError(400, 'Reference rate must be positive');
      await client.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ('reference_rate_santim', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [santim.toString()]
      );
    }
    if (updates.commissionPercent !== undefined) {
      const pct = Number(updates.commissionPercent);
      if (!Number.isInteger(pct) || pct < 0 || pct > 25) {
        throw new MarketplaceError(400, 'Commission percent must be an integer between 0 and 25');
      }
      await client.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ('commission_percent', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [String(pct)]
      );
    }
    if (updates.dailyLimitUsdt !== undefined) {
      const micro = P2PCalc.parseUsdtToMicro(updates.dailyLimitUsdt);
      if (micro <= 0n) throw new MarketplaceError(400, 'Daily limit must be positive');
      await client.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ('daily_limit_micro_usdt', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [micro.toString()]
      );
    }
    if (updates.maxDisputesBeforeSuspend !== undefined) {
      const n = Number(updates.maxDisputesBeforeSuspend);
      if (!Number.isInteger(n) || n < 1 || n > 20) {
        throw new MarketplaceError(400, 'Max disputes threshold must be between 1 and 20');
      }
      await client.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ('max_disputes_before_suspend', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [String(n)]
      );
    }

    await client.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details)
       VALUES ('ADMIN', $1, 'SETTINGS_UPDATED', 'SETTINGS', 'global', $2)`,
      [adminId, JSON.stringify(updates)]
    );

    return getSettings(client, config);
  });
}

export async function getUserDailyUsedMicroUsdt(db: Database | DbClient, userId: number): Promise<bigint> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const res = await db.query<{ gross_micro_usdt: string | number }>(
    `SELECT gross_micro_usdt FROM orders
     WHERE (buyer_user_id = $1 OR seller_user_id = $1)
       AND status NOT IN ('CANCELLED', 'EXPIRED')
       AND created_at >= $2`,
    [userId, startOfDay.toISOString()]
  );
  let sum = 0n;
  for (const row of res.rows) {
    sum += toBigInt(row.gross_micro_usdt);
  }
  return sum;
}

export async function saveVerifiedPhone(
  db: Database,
  telegramId: string,
  phoneNumber: string,
  profile?: { first_name?: string; last_name?: string; username?: string }
): Promise<DbUserRow> {
  const cleaned = phoneNumber.trim();
  if (!cleaned) throw new MarketplaceError(400, 'Phone number required');
  const existing = await db.query<DbUserRow>(`SELECT * FROM users WHERE telegram_id = $1`, [telegramId]);
  if (existing.rows.length === 0) {
    const ins = await db.query<DbUserRow>(
      `INSERT INTO users (telegram_id, first_name, last_name, username, phone_number, phone_verified)
       VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING *`,
      [telegramId, profile?.first_name || '', profile?.last_name || '', profile?.username || '', cleaned]
    );
    return ins.rows[0];
  }
  const upd = await db.query<DbUserRow>(
    `UPDATE users SET phone_number = $1, phone_verified = TRUE, updated_at = NOW() WHERE telegram_id = $2 RETURNING *`,
    [cleaned, telegramId]
  );
  return upd.rows[0];
}

export async function submitKyc(
  db: Database,
  params: {
    userId: number;
    telegramId: string;
    fullName: string;
    nationalIdNumber: string;
    idFrontFileId: string;
    selfieFileId: string;
  }
) {
  const fullName = params.fullName.trim();
  const nationalId = params.nationalIdNumber.trim();
  if (fullName.length < 3) throw new MarketplaceError(400, 'Full name is required (min 3 chars)');
  if (nationalId.length < 4) throw new MarketplaceError(400, 'National ID number is required');

  return db.withTransaction(async (client) => {
    const uRes = await client.query<DbUserRow>(`SELECT * FROM users WHERE id = $1 FOR UPDATE`, [params.userId]);
    if (uRes.rows.length === 0) throw new MarketplaceError(404, 'User not found');
    const user = uRes.rows[0];
    if (!user.phone_verified || !user.phone_number) {
      throw new MarketplaceError(400, 'Please share your phone contact via the Telegram bot /start first');
    }
    if (user.kyc_status === 'APPROVED') {
      throw new MarketplaceError(400, 'KYC is already approved');
    }
    if (user.kyc_status === 'PENDING') {
      throw new MarketplaceError(400, 'KYC submission is already pending review');
    }

    const subRes = await client.query(
      `INSERT INTO kyc_submissions (user_id, telegram_id, full_name, national_id_number, phone_number, id_front_file_id, selfie_file_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING') RETURNING *`,
      [user.id, params.telegramId, fullName, nationalId, user.phone_number, params.idFrontFileId, params.selfieFileId]
    );

    await client.query(`UPDATE users SET kyc_status = 'PENDING', updated_at = NOW() WHERE id = $1`, [user.id]);
    await client.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details)
       VALUES ('USER', $1, 'KYC_SUBMITTED', 'KYC', $2, $3)`,
      [params.telegramId, String(subRes.rows[0].id), JSON.stringify({ fullName, nationalId })]
    );

    return subRes.rows[0];
  });
}

export async function attachKycGroupMessage(
  db: Database,
  submissionId: number,
  chatId: string,
  messageId: number
): Promise<void> {
  await db.query(
    `UPDATE kyc_submissions SET admin_group_chat_id = $1, admin_group_message_id = $2 WHERE id = $3`,
    [chatId, messageId, submissionId]
  );
}

export async function reviewKyc(
  db: Database,
  params: {
    submissionId: number;
    decision: 'APPROVED' | 'REJECTED';
    reason?: string;
    adminId: string;
  }
) {
  if (params.decision === 'REJECTED' && (!params.reason || params.reason.trim().length < 2)) {
    throw new MarketplaceError(400, 'Rejection reason is required');
  }

  return db.withTransaction(async (client) => {
    const kRes = await client.query(`SELECT * FROM kyc_submissions WHERE id = $1 FOR UPDATE`, [params.submissionId]);
    if (kRes.rows.length === 0) throw new MarketplaceError(404, 'KYC submission not found');
    const sub = kRes.rows[0];

    // Idempotent check
    if (sub.status === params.decision) {
      return { submission: sub, alreadyDecided: true };
    }
    if (sub.status !== 'PENDING') {
      throw new MarketplaceError(409, `KYC submission already ${sub.status}`);
    }

    const cleanReason = params.decision === 'REJECTED' ? params.reason!.trim() : null;
    const updSub = await client.query(
      `UPDATE kyc_submissions
       SET status = $1, rejection_reason = $2, reviewed_by_admin_id = $3, reviewed_at = NOW()
       WHERE id = $4 RETURNING *`,
      [params.decision, cleanReason, params.adminId, sub.id]
    );

    await client.query(
      `UPDATE users SET kyc_status = $1, updated_at = NOW() WHERE id = $2`,
      [params.decision, sub.user_id]
    );

    await client.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details)
       VALUES ('ADMIN', $1, $2, 'KYC', $3, $4)`,
      [
        params.adminId,
        params.decision === 'APPROVED' ? 'KYC_APPROVED' : 'KYC_REJECTED',
        String(sub.id),
        JSON.stringify({ user_id: sub.user_id, telegram_id: sub.telegram_id, reason: cleanReason }),
      ]
    );

    return { submission: updSub.rows[0], alreadyDecided: false };
  });
}

async function appendLedger(
  client: DbClient,
  params: {
    userId: number;
    orderId?: number | null;
    adId?: number | null;
    entryType: string;
    availableDeltaMicro: bigint;
    lockedDeltaMicro: bigint;
    balanceAfterAvailableMicro: bigint;
    balanceAfterLockedMicro: bigint;
    reference: string;
  }
) {
  await client.query(
    `INSERT INTO escrow_ledger (
       user_id, order_id, ad_id, entry_type,
       available_delta_micro, locked_delta_micro,
       balance_after_available_micro, balance_after_locked_micro, reference
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      params.userId,
      params.orderId ?? null,
      params.adId ?? null,
      params.entryType,
      params.availableDeltaMicro.toString(),
      params.lockedDeltaMicro.toString(),
      params.balanceAfterAvailableMicro.toString(),
      params.balanceAfterLockedMicro.toString(),
      params.reference,
    ]
  );
}

export async function createDepositIntent(
  db: Database,
  config: AppConfig,
  params: { userId: number; network: 'TRC20' | 'BEP20'; usdtInput: string | number }
) {
  if (params.network !== 'TRC20' && params.network !== 'BEP20') {
    throw new MarketplaceError(400, 'Unsupported network. Use TRC20 or BEP20.');
  }
  const baseMicro = P2PCalc.parseUsdtToMicro(params.usdtInput);
  if (baseMicro < 1_000_000n) {
    throw new MarketplaceError(400, 'Minimum deposit is 1.00 USDT');
  }

  return db.withTransaction(async (client) => {
    const uRes = await client.query<DbUserRow>(`SELECT * FROM users WHERE id = $1 FOR UPDATE`, [params.userId]);
    if (uRes.rows.length === 0) throw new MarketplaceError(404, 'User not found');
    const user = uRes.rows[0];
    if (user.kyc_status !== 'APPROVED') {
      throw new MarketplaceError(403, 'KYC approval is required before depositing USDT');
    }
    if (user.is_suspended) {
      throw new MarketplaceError(403, 'Account is suspended');
    }

    // Generate unique 4-decimal micro-USDT suffix (0.0001 - 0.9999 => 100..999900 step 100)
    const activeRes = await client.query<{ unique_micro_usdt: string | number }>(
      `SELECT unique_micro_usdt FROM deposit_intents WHERE network = $1 AND status = 'PENDING' AND expires_at > NOW()`,
      [params.network]
    );
    const activeSet = new Set(activeRes.rows.map((r) => String(r.unique_micro_usdt)));

    let uniqueMicro = 0n;
    for (let attempt = 0; attempt < 200; attempt++) {
      const tag = BigInt(100 + crypto.randomInt(1, 9998) * 100);
      const candidate = baseMicro + tag;
      if (!activeSet.has(candidate.toString())) {
        uniqueMicro = candidate;
        break;
      }
    }
    if (uniqueMicro === 0n) {
      throw new MarketplaceError(503, 'Unable to allocate unique deposit amount; try again');
    }

    const intentCode = `DEP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const address = params.network === 'TRC20' ? config.depositAddressTrc20 : config.depositAddressBep20;
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    const ins = await client.query(
      `INSERT INTO deposit_intents (intent_code, user_id, network, base_micro_usdt, unique_micro_usdt, deposit_address, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7) RETURNING *`,
      [intentCode, user.id, params.network, baseMicro.toString(), uniqueMicro.toString(), address, expiresAt.toISOString()]
    );

    return ins.rows[0];
  });
}

export async function matchDepositIntent(
  db: Database,
  params: {
    intentId?: number;
    network?: 'TRC20' | 'BEP20';
    uniqueUsdtInput?: string | number;
    txHash: string;
    adminId: string;
  }
) {
  const txHash = params.txHash.trim();
  if (txHash.length < 8) throw new MarketplaceError(400, 'Valid blockchain txHash is required');

  return db.withTransaction(async (client) => {
    const dupTx = await client.query(`SELECT * FROM deposit_intents WHERE tx_hash = $1`, [txHash]);
    if (dupTx.rows.length > 0) {
      return { intent: dupTx.rows[0], alreadyMatched: true };
    }

    let intentRes;
    if (params.intentId) {
      intentRes = await client.query(`SELECT * FROM deposit_intents WHERE id = $1 FOR UPDATE`, [params.intentId]);
    } else if (params.network && params.uniqueUsdtInput !== undefined) {
      const uniqueMicro = P2PCalc.parseUsdtToMicro(params.uniqueUsdtInput);
      intentRes = await client.query(
        `SELECT * FROM deposit_intents WHERE network = $1 AND unique_micro_usdt = $2 AND status = 'PENDING' FOR UPDATE`,
        [params.network, uniqueMicro.toString()]
      );
    } else {
      throw new MarketplaceError(400, 'Provide intentId or (network + uniqueUsdtInput)');
    }

    if (intentRes.rows.length === 0) {
      throw new MarketplaceError(404, 'Matching pending deposit intent not found');
    }

    const intent = intentRes.rows[0];
    if (intent.status === 'MATCHED') {
      return { intent, alreadyMatched: true };
    }
    if (intent.status !== 'PENDING') {
      throw new MarketplaceError(409, `Deposit intent is ${intent.status}`);
    }

    const uRes = await client.query<DbUserRow>(`SELECT * FROM users WHERE id = $1 FOR UPDATE`, [intent.user_id]);
    const user = uRes.rows[0];
    const creditMicro = toBigInt(intent.unique_micro_usdt);
    const newAvail = toBigInt(user.available_micro_usdt) + creditMicro;
    const locked = toBigInt(user.locked_micro_usdt);

    await client.query(`UPDATE users SET available_micro_usdt = $1, updated_at = NOW() WHERE id = $2`, [
      newAvail.toString(),
      user.id,
    ]);

    const updIntent = await client.query(
      `UPDATE deposit_intents SET status = 'MATCHED', tx_hash = $1, matched_at = NOW(), matched_by_admin_id = $2
       WHERE id = $3 RETURNING *`,
      [txHash, params.adminId, intent.id]
    );

    await appendLedger(client, {
      userId: user.id,
      entryType: 'DEPOSIT_CREDIT',
      availableDeltaMicro: creditMicro,
      lockedDeltaMicro: 0n,
      balanceAfterAvailableMicro: newAvail,
      balanceAfterLockedMicro: locked,
      reference: `${intent.network} deposit ${intent.intent_code} tx:${txHash}`,
    });

    await client.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details)
       VALUES ('ADMIN', $1, 'DEPOSIT_MATCHED', 'DEPOSIT', $2, $3)`,
      [params.adminId, String(intent.id), JSON.stringify({ txHash, uniqueMicro: creditMicro.toString(), userId: user.id })]
    );

    return { intent: updIntent.rows[0], alreadyMatched: false, userTelegramId: user.telegram_id };
  });
}

export async function createAd(
  db: Database,
  config: AppConfig,
  params: {
    userId: number;
    direction: 'BUY' | 'SELL';
    usdtInput: string | number;
    priceEtbInput: string | number;
    minUsdtInput?: string | number;
    maxUsdtInput?: string | number;
    paymentMethods: string[];
    paymentDetails?: string;
  }
) {
  if (params.direction !== 'BUY' && params.direction !== 'SELL') {
    throw new MarketplaceError(400, 'Direction must be BUY or SELL');
  }
  const totalMicro = P2PCalc.parseUsdtToMicro(params.usdtInput);
  const priceSantim = P2PCalc.parseEtbToSantim(params.priceEtbInput);
  const minMicro = params.minUsdtInput !== undefined ? P2PCalc.parseUsdtToMicro(params.minUsdtInput) : 3_000_000n;
  const maxMicro = params.maxUsdtInput !== undefined ? P2PCalc.parseUsdtToMicro(params.maxUsdtInput) : totalMicro;

  if (totalMicro <= 0n) throw new MarketplaceError(400, 'USDT amount must be positive');
  if (minMicro <= 0n || minMicro > maxMicro || maxMicro > totalMicro) {
    throw new MarketplaceError(400, 'Invalid min/max order limits');
  }
  if (!Array.isArray(params.paymentMethods) || params.paymentMethods.length === 0) {
    throw new MarketplaceError(400, 'Select at least one payment method');
  }

  return db.withTransaction(async (client) => {
    const settings = await getSettings(client, config);
    if (!P2PCalc.isPriceWithinGuard(priceSantim, BigInt(settings.referenceRateSantim), 10)) {
      const bounds = P2PCalc.getPriceGuardBounds(BigInt(settings.referenceRateSantim), 10);
      throw new MarketplaceError(
        400,
        `Price ${P2PCalc.formatSantim(priceSantim)} ETB violates ±10% price guard (allowed: ${bounds.minEtb} - ${bounds.maxEtb} ETB)`
      );
    }

    const uRes = await client.query<DbUserRow>(`SELECT * FROM users WHERE id = $1 FOR UPDATE`, [params.userId]);
    if (uRes.rows.length === 0) throw new MarketplaceError(404, 'User not found');
    const user = uRes.rows[0];
    if (user.kyc_status !== 'APPROVED') {
      throw new MarketplaceError(403, 'KYC approval is required to post ads');
    }
    if (user.is_suspended) {
      throw new MarketplaceError(403, 'Account is suspended');
    }

    let avail = toBigInt(user.available_micro_usdt);
    let locked = toBigInt(user.locked_micro_usdt);

    if (params.direction === 'SELL') {
      if (avail < totalMicro) {
        throw new MarketplaceError(
          400,
          `Insufficient available USDT to lock (${P2PCalc.formatMicroUsdt(avail, 2)} available, ${P2PCalc.formatMicroUsdt(totalMicro, 2)} required)`
        );
      }
      avail -= totalMicro;
      locked += totalMicro;
      await client.query(
        `UPDATE users SET available_micro_usdt = $1, locked_micro_usdt = $2, updated_at = NOW() WHERE id = $3`,
        [avail.toString(), locked.toString(), user.id]
      );
    }

    const methodsCsv = params.paymentMethods.map((m) => m.trim()).filter(Boolean).join(',');
    const adRes = await client.query(
      `INSERT INTO ads (
         user_id, direction, asset, total_micro_usdt, remaining_micro_usdt,
         price_santim, min_order_micro_usdt, max_order_micro_usdt,
         payment_methods, payment_details, status
       ) VALUES ($1, $2, 'USDT', $3, $3, $4, $5, $6, $7, $8, 'ACTIVE') RETURNING *`,
      [
        user.id,
        params.direction,
        totalMicro.toString(),
        priceSantim.toString(),
        minMicro.toString(),
        maxMicro.toString(),
        methodsCsv,
        (params.paymentDetails || '').trim(),
      ]
    );
    const ad = adRes.rows[0];

    if (params.direction === 'SELL') {
      await appendLedger(client, {
        userId: user.id,
        adId: ad.id,
        entryType: 'AD_LOCK',
        availableDeltaMicro: -totalMicro,
        lockedDeltaMicro: totalMicro,
        balanceAfterAvailableMicro: avail,
        balanceAfterLockedMicro: locked,
        reference: `Locked USDT for SELL Ad #${ad.id}`,
      });
    }

    return ad;
  });
}

export async function cancelAd(db: Database, params: { adId: number; userId: number }) {
  return db.withTransaction(async (client) => {
    const adRes = await client.query(`SELECT * FROM ads WHERE id = $1 FOR UPDATE`, [params.adId]);
    if (adRes.rows.length === 0) throw new MarketplaceError(404, 'Ad not found');
    const ad = adRes.rows[0];
    if (ad.user_id !== params.userId) throw new MarketplaceError(403, 'Not ad owner');
    if (ad.status === 'CANCELLED') return ad;
    if (ad.status !== 'ACTIVE' && ad.status !== 'PAUSED') {
      throw new MarketplaceError(409, `Cannot cancel ad in status ${ad.status}`);
    }

    const remaining = toBigInt(ad.remaining_micro_usdt);
    const updAd = await client.query(
      `UPDATE ads SET status = 'CANCELLED', remaining_micro_usdt = 0, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [ad.id]
    );

    if (ad.direction === 'SELL' && remaining > 0n) {
      const uRes = await client.query<DbUserRow>(`SELECT * FROM users WHERE id = $1 FOR UPDATE`, [ad.user_id]);
      const user = uRes.rows[0];
      const newAvail = toBigInt(user.available_micro_usdt) + remaining;
      const newLocked = toBigInt(user.locked_micro_usdt) - remaining;
      if (newLocked < 0n) throw new MarketplaceError(500, 'Escrow invariant violation on ad unlock');
      await client.query(
        `UPDATE users SET available_micro_usdt = $1, locked_micro_usdt = $2, updated_at = NOW() WHERE id = $3`,
        [newAvail.toString(), newLocked.toString(), user.id]
      );
      await appendLedger(client, {
        userId: user.id,
        adId: ad.id,
        entryType: 'AD_UNLOCK',
        availableDeltaMicro: remaining,
        lockedDeltaMicro: -remaining,
        balanceAfterAvailableMicro: newAvail,
        balanceAfterLockedMicro: newLocked,
        reference: `Cancelled SELL Ad #${ad.id}`,
      });
    }

    return updAd.rows[0];
  });
}

export async function createOrder(
  db: Database,
  config: AppConfig,
  params: {
    takerUserId: number;
    adId: number;
    usdtInput: string | number;
    paymentMethod: string;
    depositNetwork?: 'TRC20' | 'BEP20' | null;
    payoutProvider?: 'BINANCE_PAY' | 'BYBIT_UID';
    payoutAccountId?: string;
    payoutAccountName?: string;
    payoutProfileFileId?: string;
  }
) {
  return db.withTransaction(async (client) => {
    const settings = await getSettings(client, config);
    const adRes = await client.query(`SELECT * FROM ads WHERE id = $1 FOR UPDATE`, [params.adId]);
    if (adRes.rows.length === 0) throw new MarketplaceError(404, 'Ad not found');
    const ad = adRes.rows[0];
    if (ad.status !== 'ACTIVE') throw new MarketplaceError(409, 'Ad is no longer active');
    if (ad.user_id === params.takerUserId) throw new MarketplaceError(400, 'Cannot trade with your own ad');

    // Lock both users in deterministic order to avoid deadlocks
    const firstId = Math.min(ad.user_id, params.takerUserId);
    const secondId = Math.max(ad.user_id, params.takerUserId);
    const u1 = await client.query<DbUserRow>(`SELECT * FROM users WHERE id = $1 FOR UPDATE`, [firstId]);
    const u2 = await client.query<DbUserRow>(`SELECT * FROM users WHERE id = $1 FOR UPDATE`, [secondId]);
    const usersMap = new Map<number, DbUserRow>();
    if (u1.rows[0]) usersMap.set(u1.rows[0].id, u1.rows[0]);
    if (u2.rows[0]) usersMap.set(u2.rows[0].id, u2.rows[0]);

    const adOwner = usersMap.get(ad.user_id)!;
    const taker = usersMap.get(params.takerUserId);
    if (!taker) throw new MarketplaceError(404, 'User not found');

    if (taker.kyc_status !== 'APPROVED') {
      throw new MarketplaceError(403, 'KYC approval is required before trading');
    }
    if (taker.is_suspended) {
      throw new MarketplaceError(403, 'Your account is suspended');
    }
    if (adOwner.is_suspended) {
      throw new MarketplaceError(409, 'Counterparty account is suspended');
    }

    const buyerUser = ad.direction === 'SELL' ? taker : adOwner;
    const sellerUser = ad.direction === 'SELL' ? adOwner : taker;

    // Server ALWAYS recomputes using calc.js and ignores any client-sent totals
    const calc = P2PCalc.calculateOrder({
      usdtInput: params.usdtInput,
      priceSantim: BigInt(ad.price_santim),
      commissionPercent: settings.commissionPercent,
    });
    const grossMicro = BigInt(calc.grossMicroStr);
    const minMicro = toBigInt(ad.min_order_micro_usdt);
    const maxMicro = toBigInt(ad.max_order_micro_usdt);
    const remainingMicro = toBigInt(ad.remaining_micro_usdt);

    if (grossMicro < minMicro || grossMicro > maxMicro) {
      throw new MarketplaceError(
        400,
        `Order amount must be between ${P2PCalc.formatMicroUsdt(minMicro, 2)} and ${P2PCalc.formatMicroUsdt(maxMicro, 2)} USDT`
      );
    }
    if (grossMicro > remainingMicro) {
      throw new MarketplaceError(400, 'Order exceeds remaining ad liquidity');
    }

    // Daily limit enforcement (500 USDT/day for APPROVED users)
    const dailyLimit = BigInt(settings.dailyLimitMicroUsdt);
    const takerUsedToday = await getUserDailyUsedMicroUsdt(client, taker.id);
    if (takerUsedToday + grossMicro > dailyLimit) {
      throw new MarketplaceError(
        403,
        `Daily trade limit exceeded (${P2PCalc.formatMicroUsdt(dailyLimit, 2)} USDT/day)`
      );
    }

    // Check payout details & KYC name match if provided upfront
    let initialStatus: OrderStatus = 'CREATED';
    let payoutProvider: string | null = null;
    let payoutAccountId: string | null = null;
    let payoutAccountName: string | null = null;
    let payoutProfileFileId: string | null = null;

    if (params.payoutProvider && params.payoutAccountId && params.payoutAccountName) {
      if (params.payoutProvider !== 'BINANCE_PAY' && params.payoutProvider !== 'BYBIT_UID') {
        throw new MarketplaceError(400, 'Payout provider must be BINANCE_PAY or BYBIT_UID');
      }
      if (!params.payoutProfileFileId) {
        throw new MarketplaceError(400, 'Payout profile screenshot is required');
      }
      const buyerKycRes = await client.query<{ full_name: string }>(
        `SELECT full_name FROM kyc_submissions WHERE user_id = $1 AND status = 'APPROVED' ORDER BY id DESC LIMIT 1`,
        [buyerUser.id]
      );
      const kycName = buyerKycRes.rows[0]?.full_name || `${buyerUser.first_name} ${buyerUser.last_name}`.trim();
      if (!namesMatchKyc(kycName, params.payoutAccountName)) {
        throw new MarketplaceError(
          400,
          `Payout account name "${params.payoutAccountName}" must match KYC verified name "${kycName}"`
        );
      }
      payoutProvider = params.payoutProvider;
      payoutAccountId = params.payoutAccountId.trim();
      payoutAccountName = params.payoutAccountName.trim();
      payoutProfileFileId = params.payoutProfileFileId;
      initialStatus = 'AWAITING_PAYMENT';
    }

    // Escrow lock
    let sellerAvail = toBigInt(sellerUser.available_micro_usdt);
    let sellerLocked = toBigInt(sellerUser.locked_micro_usdt);

    if (ad.direction === 'BUY') {
      // Taker is the seller; lock seller's available USDT now
      if (sellerAvail < grossMicro) {
        throw new MarketplaceError(
          400,
          `Insufficient available USDT (${P2PCalc.formatMicroUsdt(sellerAvail, 2)} available, ${calc.grossUsdt} needed)`
        );
      }
      sellerAvail -= grossMicro;
      sellerLocked += grossMicro;
      await client.query(
        `UPDATE users SET available_micro_usdt = $1, locked_micro_usdt = $2, updated_at = NOW() WHERE id = $3`,
        [sellerAvail.toString(), sellerLocked.toString(), sellerUser.id]
      );
    }

    const newRemaining = remainingMicro - grossMicro;
    const newAdStatus = newRemaining === 0n ? 'FILLED' : 'ACTIVE';
    await client.query(
      `UPDATE ads SET remaining_micro_usdt = $1, status = $2, updated_at = NOW() WHERE id = $3`,
      [newRemaining.toString(), newAdStatus, ad.id]
    );

    const orderCode = `ORD-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const uniqueSuffixMicro = BigInt(100 + crypto.randomInt(1, 9998) * 100);
    const uniqueMatchMicro = grossMicro + uniqueSuffixMicro;

    const orderRes = await client.query(
      `INSERT INTO orders (
         order_code, ad_id, direction, buyer_user_id, seller_user_id,
         gross_micro_usdt, fee_micro_usdt, net_micro_usdt, price_santim, etb_total_santim,
         commission_percent, payment_method, unique_match_micro_usdt, deposit_network,
         payout_provider, payout_account_id, payout_account_name, payout_profile_file_id,
         status, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [
        orderCode,
        ad.id,
        ad.direction,
        buyerUser.id,
        sellerUser.id,
        calc.grossMicroStr,
        calc.feeMicroStr,
        calc.netMicroStr,
        calc.priceSantimStr,
        calc.etbTotalSantimStr,
        calc.commissionPercent,
        params.paymentMethod,
        uniqueMatchMicro.toString(),
        params.depositNetwork || 'TRC20',
        payoutProvider,
        payoutAccountId,
        payoutAccountName,
        payoutProfileFileId,
        initialStatus,
        expiresAt.toISOString(),
      ]
    );
    const order = orderRes.rows[0];

    await appendLedger(client, {
      userId: sellerUser.id,
      orderId: order.id,
      adId: ad.id,
      entryType: 'ORDER_LOCK',
      availableDeltaMicro: ad.direction === 'BUY' ? -grossMicro : 0n,
      lockedDeltaMicro: ad.direction === 'BUY' ? grossMicro : 0n,
      balanceAfterAvailableMicro: sellerAvail,
      balanceAfterLockedMicro: sellerLocked,
      reference:
        ad.direction === 'BUY'
          ? `Locked ${calc.grossUsdt} USDT for order ${orderCode}`
          : `Allocated ${calc.grossUsdt} USDT from SELL Ad #${ad.id} to order ${orderCode}`,
    });

    return { order, calc };
  });
}

export async function attachOrderPayoutDetails(
  db: Database,
  params: {
    orderId: number;
    userId: number;
    payoutProvider: 'BINANCE_PAY' | 'BYBIT_UID';
    payoutAccountId: string;
    payoutAccountName: string;
    payoutProfileFileId: string;
  }
) {
  if (params.payoutProvider !== 'BINANCE_PAY' && params.payoutProvider !== 'BYBIT_UID') {
    throw new MarketplaceError(400, 'Payout provider must be BINANCE_PAY or BYBIT_UID');
  }
  return db.withTransaction(async (client) => {
    const oRes = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [params.orderId]);
    if (oRes.rows.length === 0) throw new MarketplaceError(404, 'Order not found');
    const order = oRes.rows[0];
    if (order.buyer_user_id !== params.userId) {
      throw new MarketplaceError(403, 'Only the USDT receiver (buyer) can set payout details');
    }
    if (order.status === 'AWAITING_PAYMENT' && order.payout_account_id === params.payoutAccountId.trim()) {
      return order;
    }
    if (order.status !== 'CREATED' && order.status !== 'AWAITING_PAYMENT') {
      throw new MarketplaceError(409, `Cannot update payout details in state ${order.status}`);
    }
    if (new Date(order.expires_at).getTime() <= Date.now()) {
      throw new MarketplaceError(409, 'Order has expired');
    }

    const uRes = await client.query<DbUserRow>(`SELECT * FROM users WHERE id = $1`, [order.buyer_user_id]);
    const buyer = uRes.rows[0];
    const kycRes = await client.query<{ full_name: string }>(
      `SELECT full_name FROM kyc_submissions WHERE user_id = $1 AND status = 'APPROVED' ORDER BY id DESC LIMIT 1`,
      [buyer.id]
    );
    const kycName = kycRes.rows[0]?.full_name || `${buyer.first_name} ${buyer.last_name}`.trim();
    if (!namesMatchKyc(kycName, params.payoutAccountName)) {
      throw new MarketplaceError(
        400,
        `Account name "${params.payoutAccountName}" must match KYC name "${kycName}"`
      );
    }

    const upd = await client.query(
      `UPDATE orders
       SET payout_provider = $1, payout_account_id = $2, payout_account_name = $3,
           payout_profile_file_id = $4, status = 'AWAITING_PAYMENT', updated_at = NOW()
       WHERE id = $5 RETURNING *`,
      [
        params.payoutProvider,
        params.payoutAccountId.trim(),
        params.payoutAccountName.trim(),
        params.payoutProfileFileId,
        order.id,
      ]
    );
    return upd.rows[0];
  });
}

export async function markOrderPaid(
  db: Database,
  params: {
    orderId: number;
    userId: number;
    paymentRef: string;
    paymentProofFileId: string;
  }
) {
  const ref = params.paymentRef.trim();
  if (ref.length < 3) throw new MarketplaceError(400, 'Transaction reference is required');
  if (!params.paymentProofFileId) throw new MarketplaceError(400, 'Payment screenshot is required');

  return db.withTransaction(async (client) => {
    const oRes = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [params.orderId]);
    if (oRes.rows.length === 0) throw new MarketplaceError(404, 'Order not found');
    const order = oRes.rows[0];
    if (order.buyer_user_id !== params.userId) {
      throw new MarketplaceError(403, 'Only the ETB payer (buyer) can mark payment as sent');
    }
    if (order.status === 'PAID_MARKED') {
      return { order, alreadyMarked: true };
    }
    if (order.status !== 'AWAITING_PAYMENT') {
      throw new MarketplaceError(409, `Order cannot be marked paid from status ${order.status}`);
    }
    if (new Date(order.expires_at).getTime() <= Date.now()) {
      throw new MarketplaceError(409, 'Order timer has expired');
    }

    const upd = await client.query(
      `UPDATE orders
       SET status = 'PAID_MARKED', payment_ref = $1, payment_proof_file_id = $2, paid_at = NOW(), updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [ref, params.paymentProofFileId, order.id]
    );

    await client.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details)
       VALUES ('USER', $1, 'ORDER_PAID_MARKED', 'ORDER', $2, $3)`,
      [String(params.userId), String(order.id), JSON.stringify({ paymentRef: ref })]
    );

    return { order: upd.rows[0], alreadyMarked: false };
  });
}

export async function confirmOrderPayment(db: Database, params: { orderId: number; adminId: string }) {
  return db.withTransaction(async (client) => {
    const oRes = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [params.orderId]);
    if (oRes.rows.length === 0) throw new MarketplaceError(404, 'Order not found');
    const order = oRes.rows[0];
    if (order.payment_confirmed_by_admin) return { order, alreadyConfirmed: true };
    if (order.status !== 'PAID_MARKED' && order.status !== 'DISPUTED') {
      throw new MarketplaceError(409, `Cannot confirm payment in state ${order.status}`);
    }
    const upd = await client.query(
      `UPDATE orders SET payment_confirmed_by_admin = TRUE, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [order.id]
    );
    await client.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details)
       VALUES ('ADMIN', $1, 'ORDER_PAYMENT_CONFIRMED', 'ORDER', $2, '')`,
      [params.adminId, String(order.id)]
    );
    return { order: upd.rows[0], alreadyConfirmed: false };
  });
}

export async function releaseOrderWithPayout(
  db: Database,
  params: {
    orderId: number;
    adminId: string;
    payoutRef?: string;
    payoutProofFileId: string;
  }
) {
  if (!params.payoutProofFileId) throw new MarketplaceError(400, 'Payout screenshot is required');

  return db.withTransaction(async (client) => {
    const oRes = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [params.orderId]);
    if (oRes.rows.length === 0) throw new MarketplaceError(404, 'Order not found');
    const order = oRes.rows[0];

    // Idempotent release guard
    if (order.status === 'RELEASED') {
      return { order, alreadyReleased: true };
    }
    if (order.status !== 'PAID_MARKED' && order.status !== 'DISPUTED') {
      throw new MarketplaceError(409, `Cannot release order from status ${order.status}`);
    }

    const sellerRes = await client.query<DbUserRow>(`SELECT * FROM users WHERE id = $1 FOR UPDATE`, [order.seller_user_id]);
    const seller = sellerRes.rows[0];
    const grossMicro = toBigInt(order.gross_micro_usdt);
    const feeMicro = toBigInt(order.fee_micro_usdt);
    const sellerAvail = toBigInt(seller.available_micro_usdt);
    const sellerLocked = toBigInt(seller.locked_micro_usdt);

    if (sellerLocked < grossMicro) {
      throw new MarketplaceError(500, 'Escrow invariant violation: insufficient locked USDT for release');
    }

    const newSellerLocked = sellerLocked - grossMicro;
    await client.query(
      `UPDATE users SET locked_micro_usdt = $1, updated_at = NOW() WHERE id = $2`,
      [newSellerLocked.toString(), seller.id]
    );

    await appendLedger(client, {
      userId: seller.id,
      orderId: order.id,
      adId: order.ad_id,
      entryType: 'ORDER_RELEASE_DEBIT',
      availableDeltaMicro: 0n,
      lockedDeltaMicro: -grossMicro,
      balanceAfterAvailableMicro: sellerAvail,
      balanceAfterLockedMicro: newSellerLocked,
      reference: `Released ${P2PCalc.formatMicroUsdt(order.net_micro_usdt, 2)} USDT payout + ${P2PCalc.formatMicroUsdt(feeMicro, 2)} fee for ${order.order_code}`,
    });

    // Record fee in commissions table ONLY when order is RELEASED
    await client.query(
      `INSERT INTO commissions (order_id, seller_user_id, commission_percent, gross_micro_usdt, fee_micro_usdt)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (order_id) DO NOTHING`,
      [order.id, seller.id, order.commission_percent, grossMicro.toString(), feeMicro.toString()]
    );

    const upd = await client.query(
      `UPDATE orders
       SET status = 'RELEASED', payment_confirmed_by_admin = TRUE,
           payout_ref = $1, payout_proof_file_id = $2, released_at = NOW(), updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [(params.payoutRef || 'ADMIN_PAYOUT').trim(), params.payoutProofFileId, order.id]
    );

    await client.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details)
       VALUES ('ADMIN', $1, 'ORDER_RELEASED', 'ORDER', $2, $3)`,
      [
        params.adminId,
        String(order.id),
        JSON.stringify({
          order_code: order.order_code,
          net_micro_usdt: String(order.net_micro_usdt),
          fee_micro_usdt: feeMicro.toString(),
          payout_ref: params.payoutRef || '',
        }),
      ]
    );

    return { order: upd.rows[0], alreadyReleased: false };
  });
}

async function unlockOrderEscrow(
  client: DbClient,
  order: any,
  targetStatus: 'CANCELLED' | 'EXPIRED',
  ledgerType: 'ORDER_UNLOCK' | 'ORDER_EXPIRE_UNLOCK'
) {
  const grossMicro = toBigInt(order.gross_micro_usdt);
  const adRes = await client.query(`SELECT * FROM ads WHERE id = $1 FOR UPDATE`, [order.ad_id]);
  const ad = adRes.rows[0];
  const sellerRes = await client.query<DbUserRow>(`SELECT * FROM users WHERE id = $1 FOR UPDATE`, [order.seller_user_id]);
  const seller = sellerRes.rows[0];

  let avail = toBigInt(seller.available_micro_usdt);
  let locked = toBigInt(seller.locked_micro_usdt);

  if (order.direction === 'SELL') {
    // Restore liquidity to SELL ad if still ACTIVE/FILLED; otherwise unlock back to seller available
    if (ad && (ad.status === 'ACTIVE' || ad.status === 'FILLED')) {
      const nextRem = toBigInt(ad.remaining_micro_usdt) + grossMicro;
      await client.query(
        `UPDATE ads SET remaining_micro_usdt = $1, status = 'ACTIVE', updated_at = NOW() WHERE id = $2`,
        [nextRem.toString(), ad.id]
      );
      await appendLedger(client, {
        userId: seller.id,
        orderId: order.id,
        adId: ad.id,
        entryType: ledgerType,
        availableDeltaMicro: 0n,
        lockedDeltaMicro: 0n,
        balanceAfterAvailableMicro: avail,
        balanceAfterLockedMicro: locked,
        reference: `${targetStatus}: Restored ${P2PCalc.formatMicroUsdt(grossMicro, 2)} USDT back to SELL Ad #${ad.id}`,
      });
    } else {
      avail += grossMicro;
      locked -= grossMicro;
      if (locked < 0n) throw new MarketplaceError(500, 'Escrow invariant violation on unlock');
      await client.query(
        `UPDATE users SET available_micro_usdt = $1, locked_micro_usdt = $2, updated_at = NOW() WHERE id = $3`,
        [avail.toString(), locked.toString(), seller.id]
      );
      await appendLedger(client, {
        userId: seller.id,
        orderId: order.id,
        adId: order.ad_id,
        entryType: ledgerType,
        availableDeltaMicro: grossMicro,
        lockedDeltaMicro: -grossMicro,
        balanceAfterAvailableMicro: avail,
        balanceAfterLockedMicro: locked,
        reference: `${targetStatus}: Unlocked ${P2PCalc.formatMicroUsdt(grossMicro, 2)} USDT for ${order.order_code}`,
      });
    }
  } else {
    // BUY ad: taker was seller and locked USDT on order create -> unlock back to seller available
    avail += grossMicro;
    locked -= grossMicro;
    if (locked < 0n) throw new MarketplaceError(500, 'Escrow invariant violation on BUY order unlock');
    await client.query(
      `UPDATE users SET available_micro_usdt = $1, locked_micro_usdt = $2, updated_at = NOW() WHERE id = $3`,
      [avail.toString(), locked.toString(), seller.id]
    );
    if (ad && (ad.status === 'ACTIVE' || ad.status === 'FILLED')) {
      const nextRem = toBigInt(ad.remaining_micro_usdt) + grossMicro;
      await client.query(
        `UPDATE ads SET remaining_micro_usdt = $1, status = 'ACTIVE', updated_at = NOW() WHERE id = $2`,
        [nextRem.toString(), ad.id]
      );
    }
    await appendLedger(client, {
      userId: seller.id,
      orderId: order.id,
      adId: order.ad_id,
      entryType: ledgerType,
      availableDeltaMicro: grossMicro,
      lockedDeltaMicro: -grossMicro,
      balanceAfterAvailableMicro: avail,
      balanceAfterLockedMicro: locked,
      reference: `${targetStatus}: Unlocked ${P2PCalc.formatMicroUsdt(grossMicro, 2)} USDT for ${order.order_code}`,
    });
  }

  const tsCol = targetStatus === 'CANCELLED' ? 'cancelled_at' : 'expired_at';
  const upd = await client.query(
    `UPDATE orders SET status = $1, ${tsCol} = NOW(), updated_at = NOW() WHERE id = $2 RETURNING *`,
    [targetStatus, order.id]
  );
  return upd.rows[0];
}

export async function cancelOrder(
  db: Database,
  params: { orderId: number; actorUserId?: number; actorAdminId?: string; reason?: string }
) {
  return db.withTransaction(async (client) => {
    const oRes = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [params.orderId]);
    if (oRes.rows.length === 0) throw new MarketplaceError(404, 'Order not found');
    const order = oRes.rows[0];

    if (order.status === 'CANCELLED') return { order, alreadyCancelled: true };
    if (order.status !== 'CREATED' && order.status !== 'AWAITING_PAYMENT' && !(params.actorAdminId && order.status === 'DISPUTED')) {
      throw new MarketplaceError(409, `Cannot cancel order in status ${order.status}`);
    }
    if (params.actorUserId && order.buyer_user_id !== params.actorUserId && order.seller_user_id !== params.actorUserId) {
      throw new MarketplaceError(403, 'Not a participant in this order');
    }

    const updatedOrder = await unlockOrderEscrow(client, order, 'CANCELLED', 'ORDER_UNLOCK');

    await client.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details)
       VALUES ($1, $2, 'ORDER_CANCELLED', 'ORDER', $3, $4)`,
      [
        params.actorAdminId ? 'ADMIN' : 'USER',
        params.actorAdminId || String(params.actorUserId),
        String(order.id),
        params.reason || '',
      ]
    );

    return { order: updatedOrder, alreadyCancelled: false };
  });
}

export async function expireOverdueOrders(db: Database, now = new Date()): Promise<any[]> {
  const expiredOrders: any[] = [];
  await db.withTransaction(async (client) => {
    const dueRes = await client.query(
      `SELECT * FROM orders
       WHERE status IN ('CREATED', 'AWAITING_PAYMENT') AND expires_at <= $1
       FOR UPDATE SKIP LOCKED`,
      [now.toISOString()]
    );
    for (const order of dueRes.rows) {
      const upd = await unlockOrderEscrow(client, order, 'EXPIRED', 'ORDER_EXPIRE_UNLOCK');
      await client.query(
        `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details)
         VALUES ('SYSTEM', 'expiry_worker', 'ORDER_EXPIRED', 'ORDER', $1, $2)`,
        [String(order.id), `Expired past ${order.expires_at}`]
      );
      expiredOrders.push(upd);
    }
  });
  return expiredOrders;
}

export async function openDispute(
  db: Database,
  params: {
    orderId: number;
    openedByUserId: number;
    isAdmin?: boolean;
    adminId?: string;
    reason: string;
    evidenceFileId?: string | null;
  }
) {
  const reason = params.reason.trim();
  if (reason.length < 3) throw new MarketplaceError(400, 'Dispute reason is required');

  return db.withTransaction(async (client) => {
    const oRes = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [params.orderId]);
    if (oRes.rows.length === 0) throw new MarketplaceError(404, 'Order not found');
    const order = oRes.rows[0];

    if (order.status === 'DISPUTED') {
      const existingDisp = await client.query(`SELECT * FROM disputes WHERE order_id = $1`, [order.id]);
      return { order, dispute: existingDisp.rows[0], alreadyDisputed: true };
    }
    if (order.status !== 'AWAITING_PAYMENT' && order.status !== 'PAID_MARKED') {
      throw new MarketplaceError(409, `Cannot open dispute when order is ${order.status}`);
    }
    if (!params.isAdmin && order.buyer_user_id !== params.openedByUserId && order.seller_user_id !== params.openedByUserId) {
      throw new MarketplaceError(403, 'Not an order participant');
    }

    const againstUserId =
      params.openedByUserId === order.buyer_user_id ? order.seller_user_id : order.buyer_user_id;

    const dispRes = await client.query(
      `INSERT INTO disputes (order_id, opened_by_user_id, against_user_id, reason, evidence_file_id, status)
       VALUES ($1, $2, $3, $4, $5, 'OPEN') RETURNING *`,
      [order.id, params.openedByUserId, againstUserId, reason, params.evidenceFileId || null]
    );

    const updOrder = await client.query(
      `UPDATE orders SET status = 'DISPUTED', disputed_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
      [order.id]
    );

    await client.query(
      `UPDATE users SET dispute_count = dispute_count + 1, updated_at = NOW() WHERE id IN ($1, $2)`,
      [order.buyer_user_id, order.seller_user_id]
    );

    await client.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details)
       VALUES ($1, $2, 'DISPUTE_OPENED', 'ORDER', $3, $4)`,
      [
        params.isAdmin ? 'ADMIN' : 'USER',
        params.adminId || String(params.openedByUserId),
        String(order.id),
        reason,
      ]
    );

    return { order: updOrder.rows[0], dispute: dispRes.rows[0], alreadyDisputed: false };
  });
}

export async function resolveDispute(
  db: Database,
  config: AppConfig,
  params: {
    disputeId: number;
    adminId: string;
    resolution: 'RESOLVED_RELEASE' | 'RESOLVED_REFUND';
    note: string;
    payoutProofFileId?: string;
    payoutRef?: string;
  }
) {
  if (params.resolution === 'RESOLVED_RELEASE' && !params.payoutProofFileId) {
    throw new MarketplaceError(400, 'Payout proof screenshot is required to release disputed order');
  }

  let orderIdForRelease: number | null = null;
  let orderIdForRefund: number | null = null;

  const prepResult = await db.withTransaction(async (client) => {
    const settings = await getSettings(client, config);
    const dRes = await client.query(`SELECT * FROM disputes WHERE id = $1 FOR UPDATE`, [params.disputeId]);
    if (dRes.rows.length === 0) throw new MarketplaceError(404, 'Dispute not found');
    const dispute = dRes.rows[0];
    if (dispute.status !== 'OPEN') {
      return { dispute, alreadyResolved: true, suspendedUserId: null as number | null };
    }

    const oRes = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [dispute.order_id]);
    const order = oRes.rows[0];

    // Losing party: if RELEASE -> seller lost; if REFUND -> buyer lost
    const losingUserId = params.resolution === 'RESOLVED_RELEASE' ? order.seller_user_id : order.buyer_user_id;
    const losingUserRes = await client.query<DbUserRow>(`SELECT * FROM users WHERE id = $1 FOR UPDATE`, [losingUserId]);
    const losingUser = losingUserRes.rows[0];
    const newLosses = (losingUser.dispute_losses || 0) + 1;
    const shouldSuspend = newLosses >= settings.maxDisputesBeforeSuspend;

    await client.query(
      `UPDATE users
       SET dispute_losses = $1,
           is_suspended = CASE WHEN $2 THEN TRUE ELSE is_suspended END,
           suspended_reason = CASE WHEN $2 THEN $3 ELSE suspended_reason END,
           updated_at = NOW()
       WHERE id = $4`,
      [
        newLosses,
        shouldSuspend,
        shouldSuspend ? `Auto-suspended after ${newLosses} dispute losses` : null,
        losingUser.id,
      ]
    );

    if (shouldSuspend) {
      await client.query(
        `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details)
         VALUES ('SYSTEM', 'dispute_guard', 'USER_AUTO_SUSPENDED', 'USER', $1, $2)`,
        [String(losingUser.id), `Reached ${newLosses} dispute losses`]
      );
    }

    const updDisp = await client.query(
      `UPDATE disputes
       SET status = $1, resolution_note = $2, resolved_by_admin_id = $3, resolved_at = NOW()
       WHERE id = $4 RETURNING *`,
      [params.resolution, params.note.trim(), params.adminId, dispute.id]
    );

    await client.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details)
       VALUES ('ADMIN', $1, 'DISPUTE_RESOLVED', 'DISPUTE', $2, $3)`,
      [params.adminId, String(dispute.id), JSON.stringify({ resolution: params.resolution, note: params.note })]
    );

    if (params.resolution === 'RESOLVED_RELEASE') {
      orderIdForRelease = order.id;
    } else {
      orderIdForRefund = order.id;
    }

    return {
      dispute: updDisp.rows[0],
      alreadyResolved: false,
      suspendedUserId: shouldSuspend ? losingUser.id : null,
    };
  });

  if (prepResult.alreadyResolved) return prepResult;

  if (orderIdForRelease) {
    await releaseOrderWithPayout(db, {
      orderId: orderIdForRelease,
      adminId: params.adminId,
      payoutRef: params.payoutRef || 'DISPUTE_RELEASE',
      payoutProofFileId: params.payoutProofFileId!,
    });
  } else if (orderIdForRefund) {
    await cancelOrder(db, {
      orderId: orderIdForRefund,
      actorAdminId: params.adminId,
      reason: `Dispute #${params.disputeId} resolved with refund: ${params.note}`,
    });
  }

  return prepResult;
}

export async function submitRating(
  db: Database,
  params: { orderId: number; raterUserId: number; score: number; comment?: string }
) {
  if (!Number.isInteger(params.score) || params.score < 1 || params.score > 5) {
    throw new MarketplaceError(400, 'Score must be an integer between 1 and 5');
  }
  return db.withTransaction(async (client) => {
    const oRes = await client.query(`SELECT * FROM orders WHERE id = $1`, [params.orderId]);
    if (oRes.rows.length === 0) throw new MarketplaceError(404, 'Order not found');
    const order = oRes.rows[0];
    if (order.status !== 'RELEASED') {
      throw new MarketplaceError(409, 'You can rate only after the order is RELEASED');
    }
    if (order.buyer_user_id !== params.raterUserId && order.seller_user_id !== params.raterUserId) {
      throw new MarketplaceError(403, 'Not an order participant');
    }
    const rateeId = params.raterUserId === order.buyer_user_id ? order.seller_user_id : order.buyer_user_id;

    const existing = await client.query(
      `SELECT * FROM ratings WHERE order_id = $1 AND rater_user_id = $2`,
      [order.id, params.raterUserId]
    );
    if (existing.rows.length > 0) {
      throw new MarketplaceError(409, 'You have already rated this order');
    }

    const rRes = await client.query(
      `INSERT INTO ratings (order_id, rater_user_id, ratee_user_id, score, comment)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [order.id, params.raterUserId, rateeId, params.score, (params.comment || '').trim().slice(0, 300)]
    );

    await client.query(
      `UPDATE users SET rating_sum = rating_sum + $1, rating_count = rating_count + 1, updated_at = NOW() WHERE id = $2`,
      [params.score, rateeId]
    );

    return rRes.rows[0];
  });
}
