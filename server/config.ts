import 'dotenv/config';

export interface AppConfig {
  port: number;
  nodeEnv: string;
  isProd: boolean;
  appUrl: string;
  botToken: string;
  botUsername: string;
  webhookSecretToken: string;
  databaseUrl: string;
  adminGroupId: string;
  adminIds: Set<string>;
  adminApiKey: string;
  commissionPercent: number;
  defaultReferenceRateSantim: number;
  defaultDailyLimitMicroUsdt: number;
  maxDisputesBeforeSuspend: number;
  depositAddressTrc20: string;
  depositAddressBep20: string;
  miniAppOrigins: string[];
  allowDevPreview: boolean;
}

export function loadConfig(): AppConfig {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';
  const botToken = process.env.BOT_TOKEN || (isProd ? '' : 'dev_local_bot_token_for_hmac_only');
  const adminIdsRaw = process.env.ADMIN_IDS || (isProd ? '' : '100001');
  const adminIds = new Set(
    adminIdsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const commissionParsed = parseInt(process.env.COMMISSION_PERCENT || '3', 10);
  const commissionPercent = Number.isInteger(commissionParsed) && commissionParsed >= 0 && commissionParsed <= 100
    ? commissionParsed
    : 3;

  const refEtbFloat = parseFloat(process.env.DEFAULT_REFERENCE_RATE_ETB || '194.00');
  const defaultReferenceRateSantim = Number.isFinite(refEtbFloat) && refEtbFloat > 0
    ? Math.round(refEtbFloat * 100)
    : 19400;

  const dailyUsdtFloat = parseFloat(process.env.DEFAULT_DAILY_LIMIT_USDT || '500');
  const defaultDailyLimitMicroUsdt = Number.isFinite(dailyUsdtFloat) && dailyUsdtFloat > 0
    ? Math.round(dailyUsdtFloat * 1_000_000)
    : 500_000_000;

  const maxDisputesParsed = parseInt(process.env.MAX_DISPUTES_BEFORE_SUSPEND || '3', 10);
  const maxDisputesBeforeSuspend = Number.isInteger(maxDisputesParsed) && maxDisputesParsed > 0
    ? maxDisputesParsed
    : 3;

  const originRaw = process.env.MINI_APP_ORIGIN || '';
  const miniAppOrigins = originRaw
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);

  return {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv,
    isProd,
    appUrl: (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/$/, ''),
    botToken,
    botUsername: process.env.BOT_USERNAME || 'EthioP2PBot',
    webhookSecretToken: process.env.WEBHOOK_SECRET_TOKEN || '',
    databaseUrl: process.env.DATABASE_URL || '',
    adminGroupId: process.env.ADMIN_GROUP_ID || '',
    adminIds,
    adminApiKey: process.env.ADMIN_API_KEY || (isProd ? '' : 'DEV_ADMIN_KEY_2026'),
    commissionPercent,
    defaultReferenceRateSantim,
    defaultDailyLimitMicroUsdt,
    maxDisputesBeforeSuspend,
    depositAddressTrc20: process.env.DEPOSIT_ADDRESS_TRC20 || 'TPlatformTRC20DepositAddressSetInEnv',
    depositAddressBep20: process.env.DEPOSIT_ADDRESS_BEP20 || '0xPlatformBEP20DepositAddressSetInEnv',
    miniAppOrigins,
    allowDevPreview: process.env.ALLOW_DEV_PREVIEW === 'true' || !isProd,
  };
}
