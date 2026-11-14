import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from './config.ts';
import type { Database } from './db.ts';

export interface VerifiedTelegramUser {
  id: string;
  first_name: string;
  last_name: string;
  username: string;
}

export interface DbUserRow {
  id: number;
  telegram_id: string;
  username: string;
  first_name: string;
  last_name: string;
  phone_number: string | null;
  phone_verified: boolean;
  kyc_status: 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED';
  available_micro_usdt: string | number;
  locked_micro_usdt: string | number;
  dispute_count: number;
  dispute_losses: number;
  is_suspended: boolean;
  suspended_reason: string | null;
  rating_sum: number;
  rating_count: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    tgUser?: VerifiedTelegramUser;
    dbUser?: DbUserRow;
    adminActorId?: string;
  }
}

export function verifyTelegramInitData(
  initDataRaw: string,
  botToken: string,
  maxAgeSeconds = 86400,
  nowSeconds = Math.floor(Date.now() / 1000)
): VerifiedTelegramUser {
  if (!initDataRaw || typeof initDataRaw !== 'string') {
    throw new Error('Missing Telegram initData');
  }
  if (!botToken) {
    throw new Error('Server BOT_TOKEN is not configured');
  }

  const params = new URLSearchParams(initDataRaw);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) {
    throw new Error('Missing or malformed initData hash');
  }

  const authDateStr = params.get('auth_date');
  const authDate = authDateStr ? parseInt(authDateStr, 10) : 0;
  if (!Number.isFinite(authDate) || authDate <= 0) {
    throw new Error('Missing or invalid auth_date');
  }
  if (nowSeconds - authDate > maxAgeSeconds) {
    throw new Error('Telegram initData has expired');
  }
  if (authDate - nowSeconds > 300) {
    throw new Error('Telegram initData auth_date is in the future');
  }

  const pairs: string[] = [];
  params.forEach((value, key) => {
    if (key !== 'hash') {
      pairs.push(`${key}=${value}`);
    }
  });
  pairs.sort((a, b) => a.localeCompare(b));
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHashHex = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const expectedBuf = Buffer.from(computedHashHex, 'hex');
  const providedBuf = Buffer.from(hash.toLowerCase(), 'hex');
  if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    throw new Error('Invalid Telegram initData signature');
  }

  const userJson = params.get('user');
  if (!userJson) {
    throw new Error('Missing user payload in initData');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(userJson);
  } catch {
    throw new Error('Malformed user JSON in initData');
  }
  if (!parsed || (typeof parsed.id !== 'number' && typeof parsed.id !== 'string')) {
    throw new Error('Invalid user.id in initData');
  }

  return {
    id: String(parsed.id),
    first_name: String(parsed.first_name || ''),
    last_name: String(parsed.last_name || ''),
    username: String(parsed.username || ''),
  };
}

export function mintTelegramInitData(
  user: { id: string | number; first_name?: string; last_name?: string; username?: string },
  botToken: string,
  authDate = Math.floor(Date.now() / 1000)
): string {
  const userObj = {
    id: Number(user.id) || String(user.id),
    first_name: user.first_name || 'User',
    last_name: user.last_name || '',
    username: user.username || '',
  };
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('query_id', `AAH_${crypto.randomBytes(6).toString('hex')}`);
  params.set('user', JSON.stringify(userObj));

  const pairs: string[] = [];
  params.forEach((value, key) => pairs.push(`${key}=${value}`));
  pairs.sort((a, b) => a.localeCompare(b));
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

export function mintAdminSessionToken(adminTelegramId: string, botToken: string, ttlSeconds = 43200): string {
  const payload = {
    aid: adminTelegramId,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    nonce: crypto.randomBytes(8).toString('hex'),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', `AdminToken:${botToken}`).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyAdminSessionToken(token: string, botToken: string): string {
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('Malformed admin token');
  const [encoded, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', `AdminToken:${botToken}`).update(encoded).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Invalid admin token signature');
  }
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (!payload.aid || !payload.exp || Math.floor(Date.now() / 1000) > Number(payload.exp)) {
    throw new Error('Expired admin token');
  }
  return String(payload.aid);
}

export function extractInitDataFromRequest(req: Request): string {
  const headerInitData = req.header('x-telegram-init-data');
  if (headerInitData) return headerInitData;
  const auth = req.header('authorization') || '';
  if (auth.toLowerCase().startsWith('tma ')) {
    return auth.slice(4).trim();
  }
  return '';
}

export function createAuthMiddleware(config: AppConfig, db: Database) {
  async function upsertAndLoadUser(tgUser: VerifiedTelegramUser): Promise<DbUserRow> {
    const existing = await db.query<DbUserRow>(
      `SELECT * FROM users WHERE telegram_id = $1`,
      [tgUser.id]
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      if (
        row.first_name !== tgUser.first_name ||
        row.last_name !== tgUser.last_name ||
        row.username !== tgUser.username
      ) {
        const updated = await db.query<DbUserRow>(
          `UPDATE users SET first_name = $1, last_name = $2, username = $3, updated_at = NOW() WHERE id = $4 RETURNING *`,
          [tgUser.first_name, tgUser.last_name, tgUser.username, row.id]
        );
        return updated.rows[0];
      }
      return row;
    }

    const inserted = await db.query<DbUserRow>(
      `INSERT INTO users (telegram_id, username, first_name, last_name) VALUES ($1, $2, $3, $4) RETURNING *`,
      [tgUser.id, tgUser.username, tgUser.first_name, tgUser.last_name]
    );
    return inserted.rows[0];
  }

  async function requireTelegramAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const raw = extractInitDataFromRequest(req);
      const tgUser = verifyTelegramInitData(raw, config.botToken);
      const dbUser = await upsertAndLoadUser(tgUser);
      req.tgUser = tgUser;
      req.dbUser = dbUser;
      next();
    } catch (err: any) {
      res.status(401).json({ error: err?.message || 'Unauthorized: Invalid Telegram initData' });
    }
  }

  async function requireAdminAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // 1) Check Telegram WebApp initData whose user.id is in ADMIN_IDS
      const rawInit = extractInitDataFromRequest(req);
      if (rawInit) {
        const tgUser = verifyTelegramInitData(rawInit, config.botToken);
        if (!config.adminIds.has(tgUser.id)) {
          res.status(403).json({ error: 'Forbidden: Telegram user is not in ADMIN_IDS' });
          return;
        }
        req.tgUser = tgUser;
        req.adminActorId = tgUser.id;
        next();
        return;
      }

      // 2) Check HMAC-signed Admin Session Token (generated via bot /admin command)
      const adminToken = req.header('x-admin-token');
      if (adminToken) {
        const aid = verifyAdminSessionToken(adminToken, config.botToken);
        if (!config.adminIds.has(aid)) {
          res.status(403).json({ error: 'Forbidden: Admin token revoked or not in ADMIN_IDS' });
          return;
        }
        req.adminActorId = aid;
        next();
        return;
      }

      // 3) Optional configured ADMIN_API_KEY
      const adminKey = req.header('x-admin-key');
      if (adminKey && config.adminApiKey) {
        const a = Buffer.from(adminKey);
        const b = Buffer.from(config.adminApiKey);
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
          req.adminActorId = Array.from(config.adminIds)[0] || 'ADMIN_KEY';
          next();
          return;
        }
      }

      res.status(401).json({ error: 'Unauthorized: Admin authentication required' });
    } catch (err: any) {
      res.status(401).json({ error: err?.message || 'Unauthorized admin access' });
    }
  }

  return {
    upsertAndLoadUser,
    requireTelegramAuth,
    requireAdminAuth,
  };
}
