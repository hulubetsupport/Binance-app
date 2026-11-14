import fs from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { newDb } from 'pg-mem';
import type { AppConfig } from './config.ts';

export interface DbClient {
  query<T extends QueryResultRow = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
  release(): void;
}

export interface Database {
  isInMemory: boolean;
  query<T extends QueryResultRow = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
  withTransaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function normalizeSqlForPgMem(sql: string): string {
  // pg-mem does not implement row-level lock clauses; real PostgreSQL executes them verbatim.
  return sql.replace(/\bFOR\s+UPDATE(\s+SKIP\s+LOCKED)?\b/gi, '');
}

export async function createDatabase(config: AppConfig, options?: { forceInMemory?: boolean; seedDemo?: boolean }): Promise<Database> {
  const usePgMem = options?.forceInMemory || !config.databaseUrl;

  let pool: Pool;
  const isInMemory = Boolean(usePgMem);

  if (usePgMem) {
    const mem = newDb({ autoCreateForeignKeyIndices: true });
    const adapter = mem.adapters.createPg();
    pool = new adapter.Pool() as unknown as Pool;
  } else {
    const isLocalhost = config.databaseUrl.includes('localhost') || config.databaseUrl.includes('127.0.0.1');
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: isLocalhost ? false : { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30000,
    });
    pool.on('error', (err) => {
      console.error('PostgreSQL pool error:', err.message);
    });
  }

  const db: Database = {
    isInMemory,
    async query<T extends QueryResultRow = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
      const finalSql = isInMemory ? normalizeSqlForPgMem(sql) : sql;
      return pool.query<T>(finalSql, params);
    },
    async withTransaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
      const rawClient: PoolClient = await pool.connect();
      const wrappedClient: DbClient = {
        query<R extends QueryResultRow = any>(sql: string, params?: any[]): Promise<QueryResult<R>> {
          const finalSql = isInMemory ? normalizeSqlForPgMem(sql) : sql;
          return rawClient.query<R>(finalSql, params);
        },
        release() {
          rawClient.release();
        },
      };
      try {
        await wrappedClient.query('BEGIN');
        const result = await fn(wrappedClient);
        await wrappedClient.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await wrappedClient.query('ROLLBACK');
        } catch {
          // ignore rollback error
        }
        throw err;
      } finally {
        wrappedClient.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };

  await initSchema(db, config, options?.seedDemo ?? isInMemory);
  return db;
}

async function initSchema(db: Database, config: AppConfig, seedDemo: boolean): Promise<void> {
  const schemaPath = path.resolve(process.cwd(), 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  if (db.isInMemory) {
    // pg-mem executes individual statements cleanly
    const withoutComments = schemaSql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    const statements = withoutComments
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await db.query(stmt);
    }
  } else {
    await db.query(schemaSql);
    // Enforce append-only on escrow_ledger in real PostgreSQL
    await db.query(`
      CREATE OR REPLACE FUNCTION prevent_ledger_mutation() RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'escrow_ledger is append-only and cannot be modified or deleted';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_escrow_ledger_immutable') THEN
          CREATE TRIGGER trg_escrow_ledger_immutable
          BEFORE UPDATE OR DELETE ON escrow_ledger
          FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
        END IF;
      END $$;
    `);
  }

  const defaultSettings: Array<[string, string]> = [
    ['reference_rate_santim', String(config.defaultReferenceRateSantim)],
    ['commission_percent', String(config.commissionPercent)],
    ['daily_limit_micro_usdt', String(config.defaultDailyLimitMicroUsdt)],
    ['max_disputes_before_suspend', String(config.maxDisputesBeforeSuspend)],
  ];

  for (const [key, value] of defaultSettings) {
    await db.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, value]
    );
  }

  if (seedDemo) {
    await seedPreviewMarketplace(db, config);
  }
}

async function seedPreviewMarketplace(db: Database, config: AppConfig): Promise<void> {
  const countRes = await db.query<{ count: string | number }>(`SELECT COUNT(*) AS count FROM users`);
  if (Number(countRes.rows[0]?.count || 0) > 0) return;

  const adminId = Array.from(config.adminIds)[0] || '100001';

  // Seed deterministic preview users: Approved Seller, Approved Buyer, Admin, Unverified User
  const sellerRes = await db.query<{ id: number }>(
    `INSERT INTO users (telegram_id, username, first_name, last_name, phone_number, phone_verified, kyc_status, available_micro_usdt, locked_micro_usdt, rating_sum, rating_count)
     VALUES ('200001', 'abebe_crypto', 'Abebe', 'Kebede', '+251911223344', TRUE, 'APPROVED', 2500000000, 1200000000, 49, 10)
     RETURNING id`
  );
  const sellerId = sellerRes.rows[0].id;

  const buyerRes = await db.query<{ id: number }>(
    `INSERT INTO users (telegram_id, username, first_name, last_name, phone_number, phone_verified, kyc_status, available_micro_usdt, locked_micro_usdt, rating_sum, rating_count)
     VALUES ('200002', 'selam_trader', 'Selam', 'Tadesse', '+251922334455', TRUE, 'APPROVED', 800000000, 0, 24, 5)
     RETURNING id`
  );
  const buyerId = buyerRes.rows[0].id;

  await db.query(
    `INSERT INTO users (telegram_id, username, first_name, last_name, phone_number, phone_verified, kyc_status, available_micro_usdt)
     VALUES ($1, 'ethiop2p_admin', 'Admin', 'Operator', '+251900000000', TRUE, 'APPROVED', 500000000)
     ON CONFLICT (telegram_id) DO NOTHING`,
    [adminId]
  );

  await db.query(
    `INSERT INTO users (telegram_id, username, first_name, last_name, phone_number, phone_verified, kyc_status, available_micro_usdt)
     VALUES ('200003', 'new_user_et', 'Dawit', 'Mekonnen', NULL, FALSE, 'NONE', 0)`
  );

  // Seed sample 1x1 PNG private file for demo KYC preview
  const tinyPngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  await db.query(
    `INSERT INTO private_files (id, owner_user_id, purpose, mime_type, size_bytes, data_base64)
     VALUES ('seed_id_front_1', $1, 'KYC_ID_FRONT', 'image/png', 68, $2),
            ('seed_selfie_1', $1, 'KYC_SELFIE', 'image/png', 68, $2)`,
    [buyerId, tinyPngB64]
  );

  // One pending KYC submission for admin review preview
  await db.query(
    `INSERT INTO users (telegram_id, username, first_name, last_name, phone_number, phone_verified, kyc_status)
     VALUES ('200004', 'hani_kyc', 'Hanna', 'Girma', '+251933445566', TRUE, 'PENDING')`
  );
  const pendingUser = await db.query<{ id: number }>(`SELECT id FROM users WHERE telegram_id = '200004'`);
  await db.query(
    `INSERT INTO kyc_submissions (user_id, telegram_id, full_name, national_id_number, phone_number, id_front_file_id, selfie_file_id, status)
     VALUES ($1, '200004', 'Hanna Girma', 'ET-FIN-8849201', '+251933445566', 'seed_id_front_1', 'seed_selfie_1', 'PENDING')`,
    [pendingUser.rows[0].id]
  );

  // Approved KYC records for seller & buyer
  await db.query(
    `INSERT INTO kyc_submissions (user_id, telegram_id, full_name, national_id_number, phone_number, id_front_file_id, selfie_file_id, status, reviewed_by_admin_id, reviewed_at)
     VALUES ($1, '200001', 'Abebe Kebede', 'ET-FIN-1102931', '+251911223344', 'seed_id_front_1', 'seed_selfie_1', 'APPROVED', $3, NOW()),
            ($2, '200002', 'Selam Tadesse', 'ET-FIN-4491022', '+251922334455', 'seed_id_front_1', 'seed_selfie_1', 'APPROVED', $3, NOW())`,
    [sellerId, buyerId, adminId]
  );

  // Seed both SELL ads and BUY ads so BUY tab & SELL tab filter distinctly!
  const sellAd1 = await db.query<{ id: number }>(
    `INSERT INTO ads (user_id, direction, total_micro_usdt, remaining_micro_usdt, price_santim, min_order_micro_usdt, max_order_micro_usdt, payment_methods, payment_details, status)
     VALUES ($1, 'SELL', 800000000, 800000000, 19450, 3000000, 500000000, 'Telebirr,CBE', 'Telebirr: 0911223344 | CBE: 1000562339427 (Abebe Kebede)', 'ACTIVE')
     RETURNING id`,
    [sellerId]
  );

  const sellAd2 = await db.query<{ id: number }>(
    `INSERT INTO ads (user_id, direction, total_micro_usdt, remaining_micro_usdt, price_santim, min_order_micro_usdt, max_order_micro_usdt, payment_methods, payment_details, status)
     VALUES ($1, 'SELL', 400000000, 400000000, 19520, 5000000, 400000000, 'CBE,Abyssinia', 'CBE: 1000562339427 | BOA: 88291022', 'ACTIVE')
     RETURNING id`,
    [sellerId]
  );

  // BUY ad (trader wants to BUY USDT and pays ETB)
  await db.query(
    `INSERT INTO ads (user_id, direction, total_micro_usdt, remaining_micro_usdt, price_santim, min_order_micro_usdt, max_order_micro_usdt, payment_methods, payment_details, status)
     VALUES ($1, 'BUY', 1000000000, 1000000000, 19280, 3000000, 500000000, 'Telebirr,CBE', 'Instant Telebirr / CBE payout by Selam Tadesse', 'ACTIVE')`,
    [buyerId]
  );

  await db.query(
    `INSERT INTO escrow_ledger (user_id, ad_id, entry_type, available_delta_micro, locked_delta_micro, balance_after_available_micro, balance_after_locked_micro, reference)
     VALUES ($1, $2, 'AD_LOCK', -800000000, 800000000, 2900000000, 800000000, 'Seed SELL ad #1 lock'),
            ($1, $3, 'AD_LOCK', -400000000, 400000000, 2500000000, 1200000000, 'Seed SELL ad #2 lock')`,
    [sellerId, sellAd1.rows[0].id, sellAd2.rows[0].id]
  );
}
