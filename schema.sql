-- EthioP2P USDT Marketplace PostgreSQL Schema
-- Pure integer amounts: micro-USDT (1e-6) and santim (1e-2 ETB)

CREATE TABLE IF NOT EXISTS settings (
  key VARCHAR(64) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  telegram_id VARCHAR(64) UNIQUE NOT NULL,
  username TEXT DEFAULT '',
  first_name TEXT DEFAULT '',
  last_name TEXT DEFAULT '',
  phone_number VARCHAR(32) DEFAULT NULL,
  phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
  kyc_status VARCHAR(16) NOT NULL DEFAULT 'NONE',
  available_micro_usdt BIGINT NOT NULL DEFAULT 0,
  locked_micro_usdt BIGINT NOT NULL DEFAULT 0,
  dispute_count INT NOT NULL DEFAULT 0,
  dispute_losses INT NOT NULL DEFAULT 0,
  is_suspended BOOLEAN NOT NULL DEFAULT FALSE,
  suspended_reason TEXT DEFAULT NULL,
  rating_sum INT NOT NULL DEFAULT 0,
  rating_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_users_kyc_status CHECK (kyc_status IN ('NONE', 'PENDING', 'APPROVED', 'REJECTED')),
  CONSTRAINT chk_users_balances_nonneg CHECK (available_micro_usdt >= 0 AND locked_micro_usdt >= 0)
);

CREATE TABLE IF NOT EXISTS private_files (
  id VARCHAR(64) PRIMARY KEY,
  owner_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  purpose VARCHAR(40) NOT NULL,
  mime_type VARCHAR(64) NOT NULL,
  size_bytes INT NOT NULL,
  data_base64 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kyc_submissions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  telegram_id VARCHAR(64) NOT NULL,
  full_name TEXT NOT NULL,
  national_id_number VARCHAR(64) NOT NULL,
  phone_number VARCHAR(32) NOT NULL,
  id_front_file_id VARCHAR(64) NOT NULL REFERENCES private_files(id),
  selfie_file_id VARCHAR(64) NOT NULL REFERENCES private_files(id),
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  rejection_reason TEXT DEFAULT NULL,
  reviewed_by_admin_id VARCHAR(64) DEFAULT NULL,
  reviewed_at TIMESTAMPTZ DEFAULT NULL,
  admin_group_chat_id VARCHAR(64) DEFAULT NULL,
  admin_group_message_id BIGINT DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_kyc_status CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED'))
);

CREATE TABLE IF NOT EXISTS ads (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction VARCHAR(8) NOT NULL,
  asset VARCHAR(16) NOT NULL DEFAULT 'USDT',
  total_micro_usdt BIGINT NOT NULL,
  remaining_micro_usdt BIGINT NOT NULL,
  price_santim BIGINT NOT NULL,
  min_order_micro_usdt BIGINT NOT NULL,
  max_order_micro_usdt BIGINT NOT NULL,
  payment_methods TEXT NOT NULL,
  payment_details TEXT DEFAULT '',
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ads_direction CHECK (direction IN ('BUY', 'SELL')),
  CONSTRAINT chk_ads_status CHECK (status IN ('ACTIVE', 'PAUSED', 'CANCELLED', 'FILLED')),
  CONSTRAINT chk_ads_amounts CHECK (total_micro_usdt > 0 AND remaining_micro_usdt >= 0 AND price_santim > 0)
);

CREATE INDEX IF NOT EXISTS idx_ads_dir_status ON ads(direction, status);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  order_code VARCHAR(32) UNIQUE NOT NULL,
  ad_id INT NOT NULL REFERENCES ads(id),
  direction VARCHAR(8) NOT NULL,
  buyer_user_id INT NOT NULL REFERENCES users(id),
  seller_user_id INT NOT NULL REFERENCES users(id),
  gross_micro_usdt BIGINT NOT NULL,
  fee_micro_usdt BIGINT NOT NULL,
  net_micro_usdt BIGINT NOT NULL,
  price_santim BIGINT NOT NULL,
  etb_total_santim BIGINT NOT NULL,
  commission_percent INT NOT NULL,
  payment_method TEXT NOT NULL,
  unique_match_micro_usdt BIGINT DEFAULT NULL,
  deposit_network VARCHAR(16) DEFAULT NULL,
  payout_provider VARCHAR(24) DEFAULT NULL,
  payout_account_id VARCHAR(128) DEFAULT NULL,
  payout_account_name TEXT DEFAULT NULL,
  payout_profile_file_id VARCHAR(64) DEFAULT NULL REFERENCES private_files(id),
  payment_ref VARCHAR(128) DEFAULT NULL,
  payment_proof_file_id VARCHAR(64) DEFAULT NULL REFERENCES private_files(id),
  payout_ref VARCHAR(128) DEFAULT NULL,
  payout_proof_file_id VARCHAR(64) DEFAULT NULL REFERENCES private_files(id),
  status VARCHAR(24) NOT NULL DEFAULT 'CREATED',
  payment_confirmed_by_admin BOOLEAN NOT NULL DEFAULT FALSE,
  admin_group_chat_id VARCHAR(64) DEFAULT NULL,
  admin_group_message_id BIGINT DEFAULT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  paid_at TIMESTAMPTZ DEFAULT NULL,
  released_at TIMESTAMPTZ DEFAULT NULL,
  cancelled_at TIMESTAMPTZ DEFAULT NULL,
  expired_at TIMESTAMPTZ DEFAULT NULL,
  disputed_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_orders_status CHECK (status IN ('CREATED', 'AWAITING_PAYMENT', 'PAID_MARKED', 'RELEASED', 'CANCELLED', 'EXPIRED', 'DISPUTED'))
);

CREATE INDEX IF NOT EXISTS idx_orders_status_expires ON orders(status, expires_at);

CREATE TABLE IF NOT EXISTS escrow_ledger (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  order_id INT DEFAULT NULL REFERENCES orders(id),
  ad_id INT DEFAULT NULL REFERENCES ads(id),
  entry_type VARCHAR(32) NOT NULL,
  available_delta_micro BIGINT NOT NULL,
  locked_delta_micro BIGINT NOT NULL,
  balance_after_available_micro BIGINT NOT NULL,
  balance_after_locked_micro BIGINT NOT NULL,
  reference TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_user ON escrow_ledger(user_id, id DESC);

CREATE TABLE IF NOT EXISTS commissions (
  id SERIAL PRIMARY KEY,
  order_id INT UNIQUE NOT NULL REFERENCES orders(id),
  seller_user_id INT NOT NULL REFERENCES users(id),
  commission_percent INT NOT NULL,
  gross_micro_usdt BIGINT NOT NULL,
  fee_micro_usdt BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS disputes (
  id SERIAL PRIMARY KEY,
  order_id INT UNIQUE NOT NULL REFERENCES orders(id),
  opened_by_user_id INT NOT NULL REFERENCES users(id),
  against_user_id INT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  evidence_file_id VARCHAR(64) DEFAULT NULL REFERENCES private_files(id),
  status VARCHAR(24) NOT NULL DEFAULT 'OPEN',
  resolution_note TEXT DEFAULT NULL,
  resolved_by_admin_id VARCHAR(64) DEFAULT NULL,
  resolved_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_dispute_status CHECK (status IN ('OPEN', 'RESOLVED_RELEASE', 'RESOLVED_REFUND'))
);

CREATE TABLE IF NOT EXISTS ratings (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders(id),
  rater_user_id INT NOT NULL REFERENCES users(id),
  ratee_user_id INT NOT NULL REFERENCES users(id),
  score INT NOT NULL CHECK (score >= 1 AND score <= 5),
  comment TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(order_id, rater_user_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  actor_type VARCHAR(16) NOT NULL,
  actor_id VARCHAR(64) NOT NULL,
  action VARCHAR(64) NOT NULL,
  target_type VARCHAR(32) NOT NULL,
  target_id VARCHAR(64) NOT NULL,
  details TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deposit_intents (
  id SERIAL PRIMARY KEY,
  intent_code VARCHAR(32) UNIQUE NOT NULL,
  user_id INT NOT NULL REFERENCES users(id),
  network VARCHAR(16) NOT NULL,
  base_micro_usdt BIGINT NOT NULL,
  unique_micro_usdt BIGINT NOT NULL,
  deposit_address TEXT NOT NULL,
  tx_hash VARCHAR(128) UNIQUE DEFAULT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  expires_at TIMESTAMPTZ NOT NULL,
  matched_at TIMESTAMPTZ DEFAULT NULL,
  matched_by_admin_id VARCHAR(64) DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_deposit_network CHECK (network IN ('TRC20', 'BEP20')),
  CONSTRAINT chk_deposit_status CHECK (status IN ('PENDING', 'MATCHED', 'EXPIRED'))
);

CREATE TABLE IF NOT EXISTS bot_sessions (
  telegram_id VARCHAR(64) PRIMARY KEY,
  step VARCHAR(48) NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
