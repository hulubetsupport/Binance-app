import cors from 'cors';
import express, { type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import multer from 'multer';
import P2PCalc from '../calc.js';
import { createAuthMiddleware, mintTelegramInitData, verifyTelegramInitData } from './auth.ts';
import { createMarketplaceBot, type MarketplaceBot } from './bot.ts';
import type { AppConfig } from './config.ts';
import type { Database } from './db.ts';
import {
  attachOrderPayoutDetails,
  cancelAd,
  cancelOrder,
  confirmOrderPayment,
  createAd,
  createDepositIntent,
  createOrder,
  expireOverdueOrders,
  getSettings,
  getUserDailyUsedMicroUsdt,
  markOrderPaid,
  MarketplaceError,
  matchDepositIntent,
  openDispute,
  releaseOrderWithPayout,
  resolveDispute,
  reviewKyc,
  saveVerifiedPhone,
  submitKyc,
  submitRating,
  updateSettings,
} from './services/marketplace.ts';
import { getPrivateImage, MAX_IMAGE_BYTES, parseDataUrlImage, savePrivateImage } from './storage.ts';

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: (err?: any) => void) => {
    fn(req, res).catch(next);
  };
}

async function resolveUploadedImage(
  db: Database,
  ownerUserId: number | null,
  purpose: string,
  file?: Express.Multer.File,
  dataUrl?: string
): Promise<string> {
  if (file && file.buffer) {
    const saved = await savePrivateImage(db, {
      ownerUserId,
      purpose,
      buffer: file.buffer,
      declaredMime: file.mimetype,
    });
    return saved.fileId;
  }
  if (dataUrl && typeof dataUrl === 'string' && dataUrl.trim().length > 0) {
    const buf = parseDataUrlImage(dataUrl);
    const saved = await savePrivateImage(db, {
      ownerUserId,
      purpose,
      buffer: buf,
    });
    return saved.fileId;
  }
  throw new MarketplaceError(400, `Image upload required for ${purpose}`);
}

export function createExpressApp(db: Database, config: AppConfig) {
  const app = express();
  app.set('trust proxy', 1);

  // HTTPS enforcement in production (Render reverse proxy sends x-forwarded-proto)
  if (config.isProd) {
    app.use((req, res, next) => {
      if (req.path === '/health') return next();
      const proto = req.header('x-forwarded-proto');
      if (proto && proto !== 'https') {
        if (req.method === 'GET' || req.method === 'HEAD') {
          return res.redirect(301, `https://${req.header('host')}${req.originalUrl}`);
        }
        return res.status(403).json({ error: 'HTTPS is required' });
      }
      next();
    });
  }

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );

  // Strict CORS restricted to configured Mini App origins (+ appUrl, and localhost in dev)
  const allowedOrigins = new Set<string>(config.miniAppOrigins);
  if (config.appUrl) allowedOrigins.add(config.appUrl);
  if (!config.isProd) {
    allowedOrigins.add('http://localhost:3000');
    allowedOrigins.add('http://127.0.0.1:3000');
    allowedOrigins.add('http://localhost:5173');
  }

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true); // non-browser / Telegram webhook / same-origin
        const normalized = origin.replace(/\/$/, '');
        if (allowedOrigins.has(normalized)) {
          return callback(null, true);
        }
        if (!config.isProd && normalized.startsWith('https://ais-')) {
          return callback(null, true);
        }
        return callback(new MarketplaceError(403, `CORS blocked origin: ${origin}`));
      },
      credentials: false,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Telegram-Init-Data',
        'X-Admin-Token',
        'X-Admin-Key',
      ],
    })
  );

  app.use(express.json({ limit: '12mb' }));

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 180,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests; please slow down.' },
  });

  const writeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 45,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Write rate limit exceeded; try again shortly.' },
  });

  app.use('/api', apiLimiter);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES, files: 4 },
  });

  const { requireTelegramAuth, requireAdminAuth } = createAuthMiddleware(config, db);
  const botRuntime: MarketplaceBot = createMarketplaceBot(db, config);

  // ── Health & Webhook ───────────────────────────────────────
  app.get('/health', async (_req, res) => {
    try {
      await db.query('SELECT 1');
      res.status(200).json({
        ok: true,
        status: 'OK',
        database: db.isInMemory ? 'in-memory-pg' : 'postgresql',
        uptimeSeconds: Math.floor(process.uptime()),
        serverTime: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(503).json({ ok: false, error: err?.message || 'DB unavailable' });
    }
  });

  app.post('/webhook/telegram', (req, res, next) => {
    if (!botRuntime.webhookMiddleware) {
      res.status(200).json({ ok: true, mode: 'disabled_no_bot_token' });
      return;
    }
    return botRuntime.webhookMiddleware(req, res, next);
  });

  // ── Public Non-Secret Marketplace Config ───────────────────
  app.get(
    '/api/config',
    asyncHandler(async (_req, res) => {
      const settings = await getSettings(db, config);
      const bounds = P2PCalc.getPriceGuardBounds(BigInt(settings.referenceRateSantim), 10);
      res.json({
        appName: 'EthioP2P USDT Marketplace',
        botUsername: config.botUsername,
        referenceRateSantim: settings.referenceRateSantim,
        referenceRateEtb: P2PCalc.formatSantim(settings.referenceRateSantim),
        priceGuardBounds: bounds,
        commissionPercent: settings.commissionPercent,
        dailyLimitMicroUsdt: settings.dailyLimitMicroUsdt,
        dailyLimitUsdt: P2PCalc.formatMicroUsdt(settings.dailyLimitMicroUsdt, 2),
        maxDisputesBeforeSuspend: settings.maxDisputesBeforeSuspend,
        depositAddresses: {
          TRC20: config.depositAddressTrc20,
          BEP20: config.depositAddressBep20,
        },
        devPreviewEnabled: !config.isProd && config.allowDevPreview,
        serverTime: new Date().toISOString(),
      });
    })
  );

  // ── Dev Preview Helper (ONLY in non-production preview; still mints real HMAC initData) ──
  if (!config.isProd && config.allowDevPreview) {
    app.get(
      '/api/dev/preview-users',
      asyncHandler(async (_req, res) => {
        const usersRes = await db.query(
          `SELECT id, telegram_id, username, first_name, last_name, phone_verified, kyc_status, available_micro_usdt, locked_micro_usdt, is_suspended
           FROM users ORDER BY id ASC LIMIT 20`
        );
        res.json({
          users: usersRes.rows.map((u) => ({
            ...u,
            isAdmin: config.adminIds.has(String(u.telegram_id)),
          })),
        });
      })
    );

    app.post(
      '/api/dev/mint-init-data',
      asyncHandler(async (req, res) => {
        const telegramId = String(req.body?.telegramId || '').trim();
        if (!telegramId) {
          res.status(400).json({ error: 'telegramId required' });
          return;
        }
        const uRes = await db.query(`SELECT * FROM users WHERE telegram_id = $1`, [telegramId]);
        const user = uRes.rows[0] || {
          id: telegramId,
          first_name: req.body?.first_name || 'PreviewUser',
          last_name: req.body?.last_name || '',
          username: req.body?.username || `user_${telegramId}`,
        };
        const initData = mintTelegramInitData(
          {
            id: user.telegram_id || telegramId,
            first_name: user.first_name,
            last_name: user.last_name,
            username: user.username,
          },
          config.botToken
        );
        res.json({ initData });
      })
    );

    app.post(
      '/api/kyc/verify-phone-dev',
      requireTelegramAuth,
      asyncHandler(async (req, res) => {
        const phone = String(req.body?.phoneNumber || '+251911000000');
        const user = await saveVerifiedPhone(db, req.tgUser!.id, phone, req.tgUser);
        res.json({ user });
      })
    );
  }

  // ── Private File Streaming (Auth: Owner or Admin ONLY) ──────
  app.get(
    '/api/files/:id',
    asyncHandler(async (req, res) => {
      const file = await getPrivateImage(db, req.params.id);
      if (!file) {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      let authorized = false;
      const adminKey = req.header('x-admin-key');
      const adminToken = req.header('x-admin-token');
      const rawInit = req.header('x-telegram-init-data') || '';

      if (adminKey && config.adminApiKey && adminKey === config.adminApiKey) {
        authorized = true;
      } else if (adminToken) {
        try {
          const { verifyAdminSessionToken } = await import('./auth.ts');
          const aid = verifyAdminSessionToken(adminToken, config.botToken);
          if (config.adminIds.has(aid)) authorized = true;
        } catch {}
      } else if (rawInit) {
        try {
          const tgUser = verifyTelegramInitData(rawInit, config.botToken);
          if (config.adminIds.has(tgUser.id)) {
            authorized = true;
          } else {
            const uRes = await db.query<{ id: number }>(`SELECT id FROM users WHERE telegram_id = $1`, [tgUser.id]);
            const callerId = uRes.rows[0]?.id;
            if (callerId && file.owner_user_id === callerId) {
              authorized = true;
            } else if (callerId) {
              // Also allow counterparty of an order to view order payment/payout proofs
              const ordRes = await db.query(
                `SELECT id FROM orders WHERE (buyer_user_id = $1 OR seller_user_id = $1)
                 AND (payment_proof_file_id = $2 OR payout_profile_file_id = $2 OR payout_proof_file_id = $2) LIMIT 1`,
                [callerId, file.id]
              );
              if (ordRes.rows.length > 0) authorized = true;
            }
          }
        } catch {}
      }

      if (!authorized) {
        res.status(403).json({ error: 'Forbidden: private file access denied' });
        return;
      }

      res.setHeader('Content-Type', file.mime_type);
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(file.buffer);
    })
  );

  // ── User Profile & KYC ─────────────────────────────────────
  app.get(
    '/api/me',
    requireTelegramAuth,
    asyncHandler(async (req, res) => {
      const user = req.dbUser!;
      const settings = await getSettings(db, config);
      const dailyUsedMicro = await getUserDailyUsedMicroUsdt(db, user.id);
      const kycRes = await db.query(
        `SELECT id, full_name, national_id_number, phone_number, status, rejection_reason, created_at, reviewed_at
         FROM kyc_submissions WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
        [user.id]
      );
      const avgRating =
        user.rating_count > 0 ? Number((user.rating_sum / user.rating_count).toFixed(2)) : null;

      res.json({
        user: {
          id: user.id,
          telegramId: user.telegram_id,
          username: user.username,
          firstName: user.first_name,
          lastName: user.last_name,
          phoneNumber: user.phone_number,
          phoneVerified: user.phone_verified,
          kycStatus: user.kyc_status,
          availableMicroUsdt: Number(user.available_micro_usdt),
          lockedMicroUsdt: Number(user.locked_micro_usdt),
          availableUsdt: P2PCalc.formatMicroUsdt(user.available_micro_usdt, 2),
          lockedUsdt: P2PCalc.formatMicroUsdt(user.locked_micro_usdt, 2),
          disputeCount: user.dispute_count,
          disputeLosses: user.dispute_losses,
          isSuspended: user.is_suspended,
          suspendedReason: user.suspended_reason,
          avgRating,
          ratingCount: user.rating_count,
          isAdmin: config.adminIds.has(user.telegram_id),
        },
        latestKyc: kycRes.rows[0] || null,
        dailyLimit: {
          limitMicroUsdt: settings.dailyLimitMicroUsdt,
          limitUsdt: P2PCalc.formatMicroUsdt(settings.dailyLimitMicroUsdt, 2),
          usedMicroUsdt: Number(dailyUsedMicro),
          usedUsdt: P2PCalc.formatMicroUsdt(dailyUsedMicro, 2),
          remainingMicroUsdt: Math.max(0, settings.dailyLimitMicroUsdt - Number(dailyUsedMicro)),
          remainingUsdt: P2PCalc.formatMicroUsdt(
            BigInt(Math.max(0, settings.dailyLimitMicroUsdt - Number(dailyUsedMicro))),
            2
          ),
        },
        serverTime: new Date().toISOString(),
      });
    })
  );

  app.post(
    '/api/kyc/submit',
    writeLimiter,
    requireTelegramAuth,
    upload.fields([
      { name: 'idFront', maxCount: 1 },
      { name: 'selfie', maxCount: 1 },
    ]),
    asyncHandler(async (req, res) => {
      const user = req.dbUser!;
      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const idFrontFileId = await resolveUploadedImage(
        db,
        user.id,
        'KYC_ID_FRONT',
        files?.idFront?.[0],
        req.body?.idFrontBase64
      );
      const selfieFileId = await resolveUploadedImage(
        db,
        user.id,
        'KYC_SELFIE',
        files?.selfie?.[0],
        req.body?.selfieBase64
      );

      const submission = await submitKyc(db, {
        userId: user.id,
        telegramId: user.telegram_id,
        fullName: String(req.body?.fullName || ''),
        nationalIdNumber: String(req.body?.nationalIdNumber || ''),
        idFrontFileId,
        selfieFileId,
      });

      await botRuntime.sendKycCardToAdminGroup(submission.id);
      res.status(201).json({ submission });
    })
  );

  // ── Ads (Strict BUY vs SELL tab filtering + 10% price guard + escrow lock) ──
  app.get(
    '/api/ads',
    requireTelegramAuth,
    asyncHandler(async (req, res) => {
      const dir = String(req.query.direction || '').toUpperCase();
      const paymentMethod = String(req.query.paymentMethod || '').trim();
      const params: any[] = [];
      const where: string[] = [`a.status = 'ACTIVE'`, `a.remaining_micro_usdt > 0`, `u.is_suspended = FALSE`];

      if (dir === 'BUY' || dir === 'SELL') {
        params.push(dir);
        where.push(`a.direction = $${params.length}`);
      }
      if (paymentMethod && paymentMethod.toLowerCase() !== 'all') {
        params.push(`%${paymentMethod}%`);
        where.push(`a.payment_methods ILIKE $${params.length}`);
      }

      const sql = `
        SELECT a.*, u.telegram_id AS creator_telegram_id, u.username AS creator_username,
               u.first_name AS creator_first_name, u.last_name AS creator_last_name,
               u.rating_sum, u.rating_count, u.kyc_status
        FROM ads a
        JOIN users u ON u.id = a.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY ${dir === 'BUY' ? 'a.price_santim DESC' : 'a.price_santim ASC'}, a.id DESC
      `;
      const rows = (await db.query(sql, params)).rows.map((a) => ({
        id: a.id,
        userId: a.user_id,
        creatorTelegramId: a.creator_telegram_id,
        creatorName: `${a.creator_first_name} ${a.creator_last_name}`.trim() || a.creator_username || 'Trader',
        creatorUsername: a.creator_username,
        creatorRating: a.rating_count > 0 ? Number((a.rating_sum / a.rating_count).toFixed(1)) : null,
        creatorRatingCount: a.rating_count,
        direction: a.direction,
        asset: a.asset,
        totalMicroUsdt: Number(a.total_micro_usdt),
        remainingMicroUsdt: Number(a.remaining_micro_usdt),
        remainingUsdt: P2PCalc.formatMicroUsdt(a.remaining_micro_usdt, 2),
        priceSantim: Number(a.price_santim),
        priceEtb: P2PCalc.formatSantim(a.price_santim),
        minOrderMicroUsdt: Number(a.min_order_micro_usdt),
        maxOrderMicroUsdt: Number(a.max_order_micro_usdt),
        minOrderUsdt: P2PCalc.formatMicroUsdt(a.min_order_micro_usdt, 2),
        maxOrderUsdt: P2PCalc.formatMicroUsdt(a.max_order_micro_usdt, 2),
        paymentMethods: String(a.payment_methods)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        paymentDetails: a.payment_details,
        status: a.status,
        createdAt: a.created_at,
      }));

      res.json({ ads: rows });
    })
  );

  app.get(
    '/api/ads/mine',
    requireTelegramAuth,
    asyncHandler(async (req, res) => {
      const rows = (
        await db.query(`SELECT * FROM ads WHERE user_id = $1 ORDER BY id DESC`, [req.dbUser!.id])
      ).rows.map((a) => ({
        ...a,
        totalUsdt: P2PCalc.formatMicroUsdt(a.total_micro_usdt, 2),
        remainingUsdt: P2PCalc.formatMicroUsdt(a.remaining_micro_usdt, 2),
        priceEtb: P2PCalc.formatSantim(a.price_santim),
      }));
      res.json({ ads: rows });
    })
  );

  app.post(
    '/api/ads',
    writeLimiter,
    requireTelegramAuth,
    asyncHandler(async (req, res) => {
      const ad = await createAd(db, config, {
        userId: req.dbUser!.id,
        direction: String(req.body?.direction || '').toUpperCase() as 'BUY' | 'SELL',
        usdtInput: req.body?.usdtAmount,
        priceEtbInput: req.body?.priceEtb,
        minUsdtInput: req.body?.minOrderUsdt,
        maxUsdtInput: req.body?.maxOrderUsdt,
        paymentMethods: Array.isArray(req.body?.paymentMethods)
          ? req.body.paymentMethods
          : String(req.body?.paymentMethods || '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
        paymentDetails: req.body?.paymentDetails,
      });
      res.status(201).json({
        ad: {
          ...ad,
          totalUsdt: P2PCalc.formatMicroUsdt(ad.total_micro_usdt, 2),
          remainingUsdt: P2PCalc.formatMicroUsdt(ad.remaining_micro_usdt, 2),
          priceEtb: P2PCalc.formatSantim(ad.price_santim),
        },
      });
    })
  );

  app.post(
    '/api/ads/:id/cancel',
    writeLimiter,
    requireTelegramAuth,
    asyncHandler(async (req, res) => {
      const adId = parseInt(req.params.id, 10);
      if (!Number.isInteger(adId)) throw new MarketplaceError(400, 'Invalid ad ID');
      const ad = await cancelAd(db, { adId, userId: req.dbUser!.id });
      res.json({ ad });
    })
  );

  // ── Orders (15-min countdown, server-recomputed calc.js, payout details, proof upload, ratings) ──
  function serializeOrder(o: any) {
    return {
      id: o.id,
      orderCode: o.order_code,
      adId: o.ad_id,
      direction: o.direction,
      buyerUserId: o.buyer_user_id,
      sellerUserId: o.seller_user_id,
      buyerName: o.buyer_name || null,
      sellerName: o.seller_name || null,
      buyerTelegramId: o.buyer_tg || null,
      sellerTelegramId: o.seller_tg || null,
      grossMicroUsdt: Number(o.gross_micro_usdt),
      feeMicroUsdt: Number(o.fee_micro_usdt),
      netMicroUsdt: Number(o.net_micro_usdt),
      priceSantim: Number(o.price_santim),
      etbTotalSantim: Number(o.etb_total_santim),
      commissionPercent: o.commission_percent,
      grossUsdt: P2PCalc.formatMicroUsdt(o.gross_micro_usdt, 2),
      feeUsdt: P2PCalc.formatMicroUsdt(o.fee_micro_usdt, 2),
      netUsdt: P2PCalc.formatMicroUsdt(o.net_micro_usdt, 2),
      priceEtb: P2PCalc.formatSantim(o.price_santim),
      etbTotal: P2PCalc.formatSantim(o.etb_total_santim),
      paymentMethod: o.payment_method,
      paymentDetails: o.ad_payment_details || null,
      uniqueMatchMicroUsdt: o.unique_match_micro_usdt ? Number(o.unique_match_micro_usdt) : null,
      uniqueMatchUsdt: o.unique_match_micro_usdt ? P2PCalc.formatMicroUsdt(o.unique_match_micro_usdt, 4) : null,
      depositNetwork: o.deposit_network,
      payoutProvider: o.payout_provider,
      payoutAccountId: o.payout_account_id,
      payoutAccountName: o.payout_account_name,
      payoutProfileFileId: o.payout_profile_file_id,
      paymentRef: o.payment_ref,
      paymentProofFileId: o.payment_proof_file_id,
      payoutRef: o.payout_ref,
      payoutProofFileId: o.payout_proof_file_id,
      status: o.status,
      paymentConfirmedByAdmin: Boolean(o.payment_confirmed_by_admin),
      expiresAt: o.expires_at,
      paidAt: o.paid_at,
      releasedAt: o.released_at,
      cancelledAt: o.cancelled_at,
      expiredAt: o.expired_at,
      disputedAt: o.disputed_at,
      createdAt: o.created_at,
      myRatingScore: o.my_rating_score ?? null,
    };
  }

  app.get(
    '/api/orders',
    requireTelegramAuth,
    asyncHandler(async (req, res) => {
      const uid = req.dbUser!.id;
      const rows = (
        await db.query(
          `SELECT o.*,
                  a.payment_details AS ad_payment_details,
                  b.first_name || ' ' || b.last_name AS buyer_name, b.telegram_id AS buyer_tg,
                  s.first_name || ' ' || s.last_name AS seller_name, s.telegram_id AS seller_tg,
                  r.score AS my_rating_score
           FROM orders o
           JOIN ads a ON a.id = o.ad_id
           JOIN users b ON b.id = o.buyer_user_id
           JOIN users s ON s.id = o.seller_user_id
           LEFT JOIN ratings r ON r.order_id = o.id AND r.rater_user_id = $1
           WHERE o.buyer_user_id = $1 OR o.seller_user_id = $1
           ORDER BY o.id DESC`,
          [uid]
        )
      ).rows;

      res.json({
        orders: rows.map(serializeOrder),
        serverTime: new Date().toISOString(),
      });
    })
  );

  app.get(
    '/api/orders/:id',
    requireTelegramAuth,
    asyncHandler(async (req, res) => {
      const orderId = parseInt(req.params.id, 10);
      if (!Number.isInteger(orderId)) throw new MarketplaceError(400, 'Invalid order ID');
      const uid = req.dbUser!.id;
      const rows = (
        await db.query(
          `SELECT o.*,
                  a.payment_details AS ad_payment_details,
                  b.first_name || ' ' || b.last_name AS buyer_name, b.telegram_id AS buyer_tg,
                  s.first_name || ' ' || s.last_name AS seller_name, s.telegram_id AS seller_tg,
                  r.score AS my_rating_score
           FROM orders o
           JOIN ads a ON a.id = o.ad_id
           JOIN users b ON b.id = o.buyer_user_id
           JOIN users s ON s.id = o.seller_user_id
           LEFT JOIN ratings r ON r.order_id = o.id AND r.rater_user_id = $2
           WHERE o.id = $1`,
          [orderId, uid]
        )
      ).rows;
      if (rows.length === 0) throw new MarketplaceError(404, 'Order not found');
      const o = rows[0];
      if (o.buyer_user_id !== uid && o.seller_user_id !== uid) {
        throw new MarketplaceError(403, 'Not an order participant');
      }
      res.json({ order: serializeOrder(o), serverTime: new Date().toISOString() });
    })
  );

  app.post(
    '/api/orders',
    writeLimiter,
    requireTelegramAuth,
    upload.single('payoutProfile'),
    asyncHandler(async (req, res) => {
      const user = req.dbUser!;
      let payoutProfileFileId: string | undefined;
      if (req.file || req.body?.payoutProfileBase64) {
        payoutProfileFileId = await resolveUploadedImage(
          db,
          user.id,
          'PAYOUT_PROFILE',
          req.file,
          req.body?.payoutProfileBase64
        );
      }

      const { order, calc } = await createOrder(db, config, {
        takerUserId: user.id,
        adId: parseInt(String(req.body?.adId), 10),
        usdtInput: req.body?.usdtAmount,
        paymentMethod: String(req.body?.paymentMethod || 'Telebirr'),
        depositNetwork: req.body?.depositNetwork || 'TRC20',
        payoutProvider: req.body?.payoutProvider,
        payoutAccountId: req.body?.payoutAccountId,
        payoutAccountName: req.body?.payoutAccountName,
        payoutProfileFileId,
      });

      res.status(201).json({
        order: serializeOrder(order),
        calculation: calc,
        serverTime: new Date().toISOString(),
      });
    })
  );

  app.post(
    '/api/orders/:id/payout-details',
    writeLimiter,
    requireTelegramAuth,
    upload.single('payoutProfile'),
    asyncHandler(async (req, res) => {
      const orderId = parseInt(req.params.id, 10);
      if (!Number.isInteger(orderId)) throw new MarketplaceError(400, 'Invalid order ID');
      const user = req.dbUser!;
      const payoutProfileFileId = await resolveUploadedImage(
        db,
        user.id,
        'PAYOUT_PROFILE',
        req.file,
        req.body?.payoutProfileBase64
      );

      const order = await attachOrderPayoutDetails(db, {
        orderId,
        userId: user.id,
        payoutProvider: String(req.body?.payoutProvider || '').toUpperCase() as 'BINANCE_PAY' | 'BYBIT_UID',
        payoutAccountId: String(req.body?.payoutAccountId || ''),
        payoutAccountName: String(req.body?.payoutAccountName || ''),
        payoutProfileFileId,
      });

      res.json({ order: serializeOrder(order), serverTime: new Date().toISOString() });
    })
  );

  app.post(
    '/api/orders/:id/mark-paid',
    writeLimiter,
    requireTelegramAuth,
    upload.single('paymentProof'),
    asyncHandler(async (req, res) => {
      const orderId = parseInt(req.params.id, 10);
      if (!Number.isInteger(orderId)) throw new MarketplaceError(400, 'Invalid order ID');
      const user = req.dbUser!;
      const paymentProofFileId = await resolveUploadedImage(
        db,
        user.id,
        'ORDER_PAYMENT_PROOF',
        req.file,
        req.body?.paymentProofBase64
      );

      const result = await markOrderPaid(db, {
        orderId,
        userId: user.id,
        paymentRef: String(req.body?.paymentRef || ''),
        paymentProofFileId,
      });

      if (!result.alreadyMarked) {
        await botRuntime.notifyOrderPaidToAdminGroup(orderId);
      }

      res.json({ order: serializeOrder(result.order), serverTime: new Date().toISOString() });
    })
  );

  app.post(
    '/api/orders/:id/cancel',
    writeLimiter,
    requireTelegramAuth,
    asyncHandler(async (req, res) => {
      const orderId = parseInt(req.params.id, 10);
      if (!Number.isInteger(orderId)) throw new MarketplaceError(400, 'Invalid order ID');
      const resCancel = await cancelOrder(db, {
        orderId,
        actorUserId: req.dbUser!.id,
        reason: String(req.body?.reason || 'Cancelled by user'),
      });
      res.json({ order: serializeOrder(resCancel.order), serverTime: new Date().toISOString() });
    })
  );

  app.post(
    '/api/orders/:id/dispute',
    writeLimiter,
    requireTelegramAuth,
    upload.single('evidence'),
    asyncHandler(async (req, res) => {
      const orderId = parseInt(req.params.id, 10);
      if (!Number.isInteger(orderId)) throw new MarketplaceError(400, 'Invalid order ID');
      const user = req.dbUser!;
      let evidenceFileId: string | null = null;
      if (req.file || req.body?.evidenceBase64) {
        evidenceFileId = await resolveUploadedImage(
          db,
          user.id,
          'DISPUTE_EVIDENCE',
          req.file,
          req.body?.evidenceBase64
        );
      }
      const result = await openDispute(db, {
        orderId,
        openedByUserId: user.id,
        reason: String(req.body?.reason || ''),
        evidenceFileId,
      });
      if (!result.alreadyDisputed) {
        await botRuntime.notifyOrderDisputedToAdminGroup(orderId, result.dispute.id, result.dispute.reason);
      }
      res.json({ order: serializeOrder(result.order), dispute: result.dispute });
    })
  );

  app.post(
    '/api/orders/:id/rate',
    writeLimiter,
    requireTelegramAuth,
    asyncHandler(async (req, res) => {
      const orderId = parseInt(req.params.id, 10);
      if (!Number.isInteger(orderId)) throw new MarketplaceError(400, 'Invalid order ID');
      const rating = await submitRating(db, {
        orderId,
        raterUserId: req.dbUser!.id,
        score: parseInt(String(req.body?.score), 10),
        comment: req.body?.comment,
      });
      res.status(201).json({ rating });
    })
  );

  // ── Wallets, Ledger & TRC20/BEP20 Deposit Intents ──────────
  app.get(
    '/api/wallet/ledger',
    requireTelegramAuth,
    asyncHandler(async (req, res) => {
      const uid = req.dbUser!.id;
      const ledgerRes = await db.query(
        `SELECT * FROM escrow_ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 50`,
        [uid]
      );
      const depositsRes = await db.query(
        `SELECT * FROM deposit_intents WHERE user_id = $1 ORDER BY id DESC LIMIT 20`,
        [uid]
      );
      res.json({
        ledger: ledgerRes.rows.map((l) => ({
          ...l,
          availableDeltaUsdt: P2PCalc.formatMicroUsdt(
            BigInt(l.available_delta_micro) < 0n ? -BigInt(l.available_delta_micro) : BigInt(l.available_delta_micro),
            2
          ),
          availableDeltaSign: BigInt(l.available_delta_micro) < 0n ? '-' : '+',
          lockedDeltaUsdt: P2PCalc.formatMicroUsdt(
            BigInt(l.locked_delta_micro) < 0n ? -BigInt(l.locked_delta_micro) : BigInt(l.locked_delta_micro),
            2
          ),
          lockedDeltaSign: BigInt(l.locked_delta_micro) < 0n ? '-' : '+',
        })),
        deposits: depositsRes.rows.map((d) => ({
          ...d,
          baseUsdt: P2PCalc.formatMicroUsdt(d.base_micro_usdt, 2),
          uniqueUsdt: P2PCalc.formatMicroUsdt(d.unique_micro_usdt, 4),
        })),
      });
    })
  );

  app.post(
    '/api/deposits/intent',
    writeLimiter,
    requireTelegramAuth,
    asyncHandler(async (req, res) => {
      const network = String(req.body?.network || '').toUpperCase() as 'TRC20' | 'BEP20';
      const intent = await createDepositIntent(db, config, {
        userId: req.dbUser!.id,
        network,
        usdtInput: req.body?.usdtAmount,
      });

      res.status(201).json({
        intent: {
          ...intent,
          baseUsdt: P2PCalc.formatMicroUsdt(intent.base_micro_usdt, 2),
          uniqueUsdt: P2PCalc.formatMicroUsdt(intent.unique_micro_usdt, 4),
          wrongNetworkWarning:
            network === 'TRC20'
              ? 'WARNING: Send ONLY USDT on TRON (TRC20). Sending BEP20, ERC20, or any other token/network will result in permanent loss of funds! / ማስጠንቀቂያ፡ USDT በ TRC20 (Tron) ኔትወርክ ብቻ ይላኩ!'
              : 'WARNING: Send ONLY USDT on BNB Smart Chain (BEP20). Sending TRC20, ERC20, or any other token/network will result in permanent loss of funds! / ማስጠንቀቂያ፡ USDT በ BEP20 (BSC) ኔትወርክ ብቻ ይላኩ!',
        },
        serverTime: new Date().toISOString(),
      });
    })
  );

  // ── Admin Dashboard REST APIs ──────────────────────────────
  app.get(
    '/api/admin/overview',
    requireAdminAuth,
    asyncHandler(async (_req, res) => {
      const settings = await getSettings(db, config);
      const pendingKyc = await db.query(`SELECT COUNT(*) AS c FROM kyc_submissions WHERE status = 'PENDING'`);
      const activeOrders = await db.query(
        `SELECT COUNT(*) AS c FROM orders WHERE status IN ('CREATED', 'AWAITING_PAYMENT', 'PAID_MARKED')`
      );
      const pendingPayouts = await db.query(`SELECT COUNT(*) AS c FROM orders WHERE status = 'PAID_MARKED'`);
      const openDisputes = await db.query(`SELECT COUNT(*) AS c FROM disputes WHERE status = 'OPEN'`);
      const pendingDeposits = await db.query(`SELECT COUNT(*) AS c FROM deposit_intents WHERE status = 'PENDING'`);
      const commRows = await db.query<{ fee_micro_usdt: string | number }>(`SELECT fee_micro_usdt FROM commissions`);
      let totalFeeMicro = 0n;
      for (const r of commRows.rows) totalFeeMicro += BigInt(r.fee_micro_usdt);

      res.json({
        kpis: {
          pendingKyc: Number(pendingKyc.rows[0]?.c || 0),
          activeOrders: Number(activeOrders.rows[0]?.c || 0),
          pendingPayouts: Number(pendingPayouts.rows[0]?.c || 0),
          openDisputes: Number(openDisputes.rows[0]?.c || 0),
          pendingDeposits: Number(pendingDeposits.rows[0]?.c || 0),
          totalCommissionMicroUsdt: Number(totalFeeMicro),
          totalCommissionUsdt: P2PCalc.formatMicroUsdt(totalFeeMicro, 2),
        },
        settings: {
          ...settings,
          referenceRateEtb: P2PCalc.formatSantim(settings.referenceRateSantim),
          dailyLimitUsdt: P2PCalc.formatMicroUsdt(settings.dailyLimitMicroUsdt, 2),
        },
        adminActorId: _req.adminActorId,
      });
    })
  );

  app.get(
    '/api/admin/kyc',
    requireAdminAuth,
    asyncHandler(async (req, res) => {
      const status = String(req.query.status || 'ALL').toUpperCase();
      const params: any[] = [];
      let where = '';
      if (status === 'PENDING' || status === 'APPROVED' || status === 'REJECTED') {
        params.push(status);
        where = `WHERE k.status = $1`;
      }
      const rows = (
        await db.query(
          `SELECT k.*, u.username, u.first_name, u.last_name
           FROM kyc_submissions k JOIN users u ON u.id = k.user_id
           ${where}
           ORDER BY k.id DESC LIMIT 100`,
          params
        )
      ).rows;
      res.json({ submissions: rows });
    })
  );

  app.post(
    '/api/admin/kyc/:id/review',
    requireAdminAuth,
    asyncHandler(async (req, res) => {
      const subId = parseInt(req.params.id, 10);
      const decision = String(req.body?.decision || '').toUpperCase() as 'APPROVED' | 'REJECTED';
      if (decision !== 'APPROVED' && decision !== 'REJECTED') {
        throw new MarketplaceError(400, 'decision must be APPROVED or REJECTED');
      }
      const result = await reviewKyc(db, {
        submissionId: subId,
        decision,
        reason: req.body?.reason,
        adminId: req.adminActorId!,
      });
      if (!result.alreadyDecided) {
        await botRuntime.notifyUser(
          result.submission.telegram_id,
          decision === 'APPROVED'
            ? `🎉 Your KYC is APPROVED! You can now post ads and trade on EthioP2P.`
            : `❌ Your KYC was REJECTED. Reason: ${result.submission.rejection_reason}`
        );
      }
      res.json(result);
    })
  );

  app.get(
    '/api/admin/orders',
    requireAdminAuth,
    asyncHandler(async (req, res) => {
      const status = String(req.query.status || 'ALL').toUpperCase();
      const params: any[] = [];
      let where = '';
      if (status !== 'ALL') {
        params.push(status);
        where = `WHERE o.status = $1`;
      }
      const rows = (
        await db.query(
          `SELECT o.*,
                  a.payment_details AS ad_payment_details,
                  b.first_name || ' ' || b.last_name AS buyer_name, b.telegram_id AS buyer_tg,
                  s.first_name || ' ' || s.last_name AS seller_name, s.telegram_id AS seller_tg
           FROM orders o
           JOIN ads a ON a.id = o.ad_id
           JOIN users b ON b.id = o.buyer_user_id
           JOIN users s ON s.id = o.seller_user_id
           ${where}
           ORDER BY o.id DESC LIMIT 120`,
          params
        )
      ).rows;
      res.json({ orders: rows.map(serializeOrder), serverTime: new Date().toISOString() });
    })
  );

  app.post(
    '/api/admin/orders/:id/confirm-payment',
    requireAdminAuth,
    asyncHandler(async (req, res) => {
      const orderId = parseInt(req.params.id, 10);
      const result = await confirmOrderPayment(db, { orderId, adminId: req.adminActorId! });
      res.json({ order: serializeOrder(result.order) });
    })
  );

  app.post(
    '/api/admin/orders/:id/paid-out',
    requireAdminAuth,
    upload.single('payoutProof'),
    asyncHandler(async (req, res) => {
      const orderId = parseInt(req.params.id, 10);
      const payoutProofFileId = await resolveUploadedImage(
        db,
        null,
        'ORDER_PAYOUT_PROOF',
        req.file,
        req.body?.payoutProofBase64
      );
      const result = await releaseOrderWithPayout(db, {
        orderId,
        adminId: req.adminActorId!,
        payoutRef: req.body?.payoutRef,
        payoutProofFileId,
      });

      if (!result.alreadyReleased) {
        const parties = await db.query(
          `SELECT b.telegram_id AS buyer_tg, s.telegram_id AS seller_tg FROM orders o
           JOIN users b ON b.id = o.buyer_user_id JOIN users s ON s.id = o.seller_user_id WHERE o.id = $1`,
          [orderId]
        );
        if (parties.rows[0]) {
          await botRuntime.notifyUser(
            parties.rows[0].buyer_tg,
            `🎉 Order <b>${result.order.order_code}</b> RELEASED! ${P2PCalc.formatMicroUsdt(result.order.net_micro_usdt, 2)} USDT sent to ${result.order.payout_provider} (${result.order.payout_account_id}).`
          );
          await botRuntime.notifyUser(
            parties.rows[0].seller_tg,
            `✅ Order <b>${result.order.order_code}</b> RELEASED. Commission: ${P2PCalc.formatMicroUsdt(result.order.fee_micro_usdt, 2)} USDT.`
          );
        }
      }

      res.json({ order: serializeOrder(result.order) });
    })
  );

  app.get(
    '/api/admin/deposits',
    requireAdminAuth,
    asyncHandler(async (_req, res) => {
      const rows = (
        await db.query(
          `SELECT d.*, u.telegram_id, u.first_name, u.last_name, u.username
           FROM deposit_intents d JOIN users u ON u.id = d.user_id
           ORDER BY d.id DESC LIMIT 100`
        )
      ).rows;
      res.json({
        deposits: rows.map((d) => ({
          ...d,
          baseUsdt: P2PCalc.formatMicroUsdt(d.base_micro_usdt, 2),
          uniqueUsdt: P2PCalc.formatMicroUsdt(d.unique_micro_usdt, 4),
        })),
      });
    })
  );

  app.post(
    '/api/admin/deposits/match',
    requireAdminAuth,
    asyncHandler(async (req, res) => {
      const result = await matchDepositIntent(db, {
        intentId: req.body?.intentId ? parseInt(String(req.body.intentId), 10) : undefined,
        network: req.body?.network,
        uniqueUsdtInput: req.body?.uniqueUsdtAmount,
        txHash: String(req.body?.txHash || ''),
        adminId: req.adminActorId!,
      });
      if (!result.alreadyMatched && result.userTelegramId) {
        await botRuntime.notifyUser(
          result.userTelegramId,
          `💰 Deposit Matched (${result.intent.network}): <b>${P2PCalc.formatMicroUsdt(result.intent.unique_micro_usdt, 4)} USDT</b> credited to your available balance.`
        );
      }
      res.json(result);
    })
  );

  app.get(
    '/api/admin/disputes',
    requireAdminAuth,
    asyncHandler(async (_req, res) => {
      const rows = (
        await db.query(
          `SELECT d.*, o.order_code, o.gross_micro_usdt, o.etb_total_santim, o.payment_method,
                  o.payment_proof_file_id, o.payout_profile_file_id, o.payout_provider, o.payout_account_id,
                  ou.first_name || ' ' || ou.last_name AS opened_by_name, ou.telegram_id AS opened_by_tg,
                  au.first_name || ' ' || au.last_name AS against_name, au.telegram_id AS against_tg
           FROM disputes d
           JOIN orders o ON o.id = d.order_id
           JOIN users ou ON ou.id = d.opened_by_user_id
           JOIN users au ON au.id = d.against_user_id
           ORDER BY d.id DESC LIMIT 100`
        )
      ).rows.map((d) => ({
        ...d,
        grossUsdt: P2PCalc.formatMicroUsdt(d.gross_micro_usdt, 2),
        etbTotal: P2PCalc.formatSantim(d.etb_total_santim),
      }));
      res.json({ disputes: rows });
    })
  );

  app.post(
    '/api/admin/disputes/:id/resolve',
    requireAdminAuth,
    upload.single('payoutProof'),
    asyncHandler(async (req, res) => {
      const disputeId = parseInt(req.params.id, 10);
      const resolution = String(req.body?.resolution || '').toUpperCase() as 'RESOLVED_RELEASE' | 'RESOLVED_REFUND';
      if (resolution !== 'RESOLVED_RELEASE' && resolution !== 'RESOLVED_REFUND') {
        throw new MarketplaceError(400, 'resolution must be RESOLVED_RELEASE or RESOLVED_REFUND');
      }
      let payoutProofFileId: string | undefined;
      if (resolution === 'RESOLVED_RELEASE') {
        payoutProofFileId = await resolveUploadedImage(
          db,
          null,
          'DISPUTE_PAYOUT_PROOF',
          req.file,
          req.body?.payoutProofBase64
        );
      }
      const result = await resolveDispute(db, config, {
        disputeId,
        adminId: req.adminActorId!,
        resolution,
        note: String(req.body?.note || ''),
        payoutRef: req.body?.payoutRef,
        payoutProofFileId,
      });
      res.json(result);
    })
  );

  app.get(
    '/api/admin/users',
    requireAdminAuth,
    asyncHandler(async (_req, res) => {
      const rows = (
        await db.query(
          `SELECT id, telegram_id, username, first_name, last_name, phone_number, kyc_status,
                  available_micro_usdt, locked_micro_usdt, dispute_count, dispute_losses,
                  is_suspended, suspended_reason, rating_sum, rating_count, created_at
           FROM users ORDER BY id DESC LIMIT 150`
        )
      ).rows.map((u) => ({
        ...u,
        availableUsdt: P2PCalc.formatMicroUsdt(u.available_micro_usdt, 2),
        lockedUsdt: P2PCalc.formatMicroUsdt(u.locked_micro_usdt, 2),
      }));
      res.json({ users: rows });
    })
  );

  app.post(
    '/api/admin/users/:id/unsuspend',
    requireAdminAuth,
    asyncHandler(async (req, res) => {
      const uid = parseInt(req.params.id, 10);
      const upd = await db.query(
        `UPDATE users SET is_suspended = FALSE, suspended_reason = NULL, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [uid]
      );
      if (upd.rows.length === 0) throw new MarketplaceError(404, 'User not found');
      await db.query(
        `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details)
         VALUES ('ADMIN', $1, 'USER_UNSUSPENDED', 'USER', $2, '')`,
        [req.adminActorId!, String(uid)]
      );
      res.json({ user: upd.rows[0] });
    })
  );

  app.post(
    '/api/admin/settings',
    requireAdminAuth,
    asyncHandler(async (req, res) => {
      const updated = await updateSettings(db, config, req.adminActorId!, {
        referenceRateEtb: req.body?.referenceRateEtb,
        commissionPercent: req.body?.commissionPercent !== undefined ? Number(req.body.commissionPercent) : undefined,
        dailyLimitUsdt: req.body?.dailyLimitUsdt,
        maxDisputesBeforeSuspend:
          req.body?.maxDisputesBeforeSuspend !== undefined ? Number(req.body.maxDisputesBeforeSuspend) : undefined,
      });
      res.json({
        settings: {
          ...updated,
          referenceRateEtb: P2PCalc.formatSantim(updated.referenceRateSantim),
          dailyLimitUsdt: P2PCalc.formatMicroUsdt(updated.dailyLimitMicroUsdt, 2),
        },
      });
    })
  );

  app.get(
    '/api/admin/audit-log',
    requireAdminAuth,
    asyncHandler(async (_req, res) => {
      const logs = (await db.query(`SELECT * FROM audit_log ORDER BY id DESC LIMIT 100`)).rows;
      const commissions = (
        await db.query(
          `SELECT c.*, o.order_code, u.telegram_id AS seller_tg, u.first_name || ' ' || u.last_name AS seller_name
           FROM commissions c
           JOIN orders o ON o.id = c.order_id
           JOIN users u ON u.id = c.seller_user_id
           ORDER BY c.id DESC LIMIT 50`
        )
      ).rows.map((c) => ({
        ...c,
        grossUsdt: P2PCalc.formatMicroUsdt(c.gross_micro_usdt, 2),
        feeUsdt: P2PCalc.formatMicroUsdt(c.fee_micro_usdt, 2),
      }));
      res.json({ auditLogs: logs, commissions });
    })
  );

  // Error handler
  app.use((err: any, _req: Request, res: Response, _next: any) => {
    const status = err instanceof MarketplaceError ? err.status : err?.status || 500;
    const message = err?.message || 'Internal server error';
    if (status >= 500) {
      console.error('Server error:', err);
    }
    res.status(status).json({ error: message });
  });

  function startExpiryWorker(): NodeJS.Timeout {
    return setInterval(async () => {
      try {
        const expired = await expireOverdueOrders(db);
        for (const o of expired) {
          const parties = await db.query(
            `SELECT b.telegram_id AS buyer_tg, s.telegram_id AS seller_tg FROM users b, users s WHERE b.id = $1 AND s.id = $2`,
            [o.buyer_user_id, o.seller_user_id]
          );
          if (parties.rows[0]) {
            await botRuntime.notifyUser(
              parties.rows[0].buyer_tg,
              `⏱ Order <b>${o.order_code}</b> expired after 15 minutes. No payment was marked.`
            );
            await botRuntime.notifyUser(
              parties.rows[0].seller_tg,
              `⏱ Order <b>${o.order_code}</b> expired after 15 minutes. Locked USDT has been unlocked.`
            );
          }
        }
      } catch (err: any) {
        console.error('Expiry worker error:', err?.message);
      }
    }, 30_000);
  }

  return { app, botRuntime, startExpiryWorker };
}
