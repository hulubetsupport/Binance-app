import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownUp,
  CheckCircle2,
  Copy,
  ExternalLink,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Star,
  User,
  Wallet,
} from 'lucide-react';
import P2PCalc from '../../calc.js';
import {
  apiFetch,
  fileToDataUrl,
  getInitialApiBase,
  getSavedDevTgId,
  setSavedDevTgId,
  setStoredApiBase,
} from '../api';
import { OrderCountdown, OrderStatusTimeline } from './OrderCountdown';
import { PrivateImage } from './PrivateImage';

type TabId = 'home' | 'p2p' | 'wallets' | 'orders' | 'profile';

interface MiniAppProps {
  initData: string;
  isTelegramEnv: boolean;
  onChangeDevUser: (telegramId: string) => Promise<void>;
  onOpenAdmin: () => void;
}

const PAYMENT_OPTIONS = ['Telebirr', 'CBE', 'Dashen', 'Awash', 'Abyssinia'];

export function MiniApp({ initData, isTelegramEnv, onChangeDevUser, onOpenAdmin }: MiniAppProps) {
  const [tab, setTab] = useState<TabId>('home');
  const [lang, setLang] = useState<'bilingual' | 'am'>('bilingual');
  const [apiBase, setApiBase] = useState<string>(() => getInitialApiBase());
  const [showServerModal, setShowServerModal] = useState(false);
  const [serverUrlInput, setServerUrlInput] = useState<string>(() => getInitialApiBase());

  const [config, setConfig] = useState<any>(null);
  const [me, setMe] = useState<any>(null);
  const [dailyLimit, setDailyLimit] = useState<any>(null);
  const [latestKyc, setLatestKyc] = useState<any>(null);
  const [serverOffsetMs, setServerOffsetMs] = useState<number>(0);

  const [previewUsers, setPreviewUsers] = useState<any[]>([]);
  const [selectedDevTgId, setSelectedDevTgId] = useState<string>(() => getSavedDevTgId());

  const [p2pDirection, setP2pDirection] = useState<'SELL' | 'BUY'>('SELL');
  const [paymentFilter, setPaymentFilter] = useState<string>('ALL');
  const [ads, setAds] = useState<any[]>([]);
  const [myAds, setMyAds] = useState<any[]>([]);

  const [orders, setOrders] = useState<any[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);

  const [ledger, setLedger] = useState<any[]>([]);
  const [deposits, setDeposits] = useState<any[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Post Ad modal state
  const [showPostAd, setShowPostAd] = useState(false);
  const [adDirection, setAdDirection] = useState<'SELL' | 'BUY'>('SELL');
  const [adAmount, setAdAmount] = useState('100');
  const [adPrice, setAdPrice] = useState('155.00');
  const [adMin, setAdMin] = useState('10');
  const [adMax, setAdMax] = useState('100');
  const [adMethods, setAdMethods] = useState<string[]>(['Telebirr', 'CBE']);
  const [adPaymentDetails, setAdPaymentDetails] = useState('');

  // Take Order modal state
  const [tradeAd, setTradeAd] = useState<any>(null);
  const [tradeUsdt, setTradeUsdt] = useState('100');
  const [tradeMethod, setTradeMethod] = useState('Telebirr');
  const [tradeNetwork, setTradeNetwork] = useState<'TRC20' | 'BEP20'>('TRC20');
  const [tradePayoutProvider, setTradePayoutProvider] = useState<'BINANCE_PAY' | 'BYBIT_UID'>('BINANCE_PAY');
  const [tradePayoutId, setTradePayoutId] = useState('');
  const [tradePayoutName, setTradePayoutName] = useState('');
  const [tradePayoutFile, setTradePayoutFile] = useState<File | null>(null);

  // Order detail action inputs
  const [ordPayoutProvider, setOrdPayoutProvider] = useState<'BINANCE_PAY' | 'BYBIT_UID'>('BINANCE_PAY');
  const [ordPayoutId, setOrdPayoutId] = useState('');
  const [ordPayoutName, setOrdPayoutName] = useState('');
  const [ordPayoutFile, setOrdPayoutFile] = useState<File | null>(null);

  const [payRef, setPayRef] = useState('');
  const [payFile, setPayFile] = useState<File | null>(null);

  const [disputeReason, setDisputeReason] = useState('');
  const [disputeFile, setDisputeFile] = useState<File | null>(null);
  const [showDisputeBox, setShowDisputeBox] = useState(false);

  const [ratingScore, setRatingScore] = useState(5);
  const [ratingComment, setRatingComment] = useState('');

  // Deposit intent inputs
  const [depNetwork, setDepNetwork] = useState<'TRC20' | 'BEP20'>('TRC20');
  const [depAmount, setDepAmount] = useState('100');

  // KYC form inputs
  const [kycName, setKycName] = useState('');
  const [kycIdNumber, setKycIdNumber] = useState('');
  const [kycIdFrontFile, setKycIdFrontFile] = useState<File | null>(null);
  const [kycSelfieFile, setKycSelfieFile] = useState<File | null>(null);
  const [devPhoneInput, setDevPhoneInput] = useState('+251911223344');

  const t = (en: string, am: string) => (lang === 'am' ? am : `${en} · ${am}`);

  const loadMarketplace = useCallback(async () => {
    setError('');
    try {
      const cfg = await apiFetch('/api/config', { apiBase });
      setConfig(cfg);
      if (cfg.serverTime) {
        setServerOffsetMs(new Date(cfg.serverTime).getTime() - Date.now());
      }
      if (cfg.devPreviewEnabled && !isTelegramEnv) {
        try {
          const prev = await apiFetch('/api/dev/preview-users', { apiBase });
          setPreviewUsers(prev.users || []);
        } catch {
          // ignore if endpoint disabled
        }
      }
    } catch (e: any) {
      setError(e?.message || 'Unable to reach marketplace backend');
    }

    if (!initData) return;

    setLoading(true);
    try {
      const [meRes, adsRes, myAdsRes, ordRes, walletRes] = await Promise.all([
        apiFetch('/api/me', { initData, apiBase }),
        apiFetch(
          `/api/ads?direction=${p2pDirection}&paymentMethod=${encodeURIComponent(paymentFilter)}`,
          { initData, apiBase }
        ),
        apiFetch('/api/ads/mine', { initData, apiBase }),
        apiFetch('/api/orders', { initData, apiBase }),
        apiFetch('/api/wallet/ledger', { initData, apiBase }),
      ]);

      setMe(meRes.user);
      setDailyLimit(meRes.dailyLimit);
      setLatestKyc(meRes.latestKyc);
      if (meRes.serverTime) {
        setServerOffsetMs(new Date(meRes.serverTime).getTime() - Date.now());
      }
      if (meRes.latestKyc?.full_name && !kycName) {
        setKycName(meRes.latestKyc.full_name);
      }
      setAds(adsRes.ads || []);
      setMyAds(myAdsRes.ads || []);
      setOrders(ordRes.orders || []);
      if (ordRes.orders?.length > 0 && !selectedOrderId) {
        setSelectedOrderId(ordRes.orders[0].id);
      }
      setLedger(walletRes.ledger || []);
      setDeposits(walletRes.deposits || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load marketplace data');
    } finally {
      setLoading(false);
    }
  }, [apiBase, initData, isTelegramEnv, p2pDirection, paymentFilter, selectedOrderId, kycName]);

  useEffect(() => {
    loadMarketplace();
  }, [loadMarketplace]);

  // Live calculation previews using the ONE shared calc.js integer module
  const postAdPreview = useMemo(() => {
    try {
      return P2PCalc.calculateOrder({
        usdtInput: adAmount,
        priceEtbInput: adPrice,
        commissionPercent: config?.commissionPercent ?? 3,
      });
    } catch {
      return null;
    }
  }, [adAmount, adPrice, config?.commissionPercent]);

  const tradePreview = useMemo(() => {
    if (!tradeAd) return null;
    try {
      return P2PCalc.calculateOrder({
        usdtInput: tradeUsdt,
        priceSantim: BigInt(tradeAd.priceSantim),
        commissionPercent: config?.commissionPercent ?? 3,
      });
    } catch {
      return null;
    }
  }, [tradeAd, tradeUsdt, config?.commissionPercent]);

  const homeEtbApprox = useMemo(() => {
    if (!me || !config?.referenceRateSantim) return '0.00';
    try {
      const totalMicro = BigInt(me.availableMicroUsdt) + BigInt(me.lockedMicroUsdt);
      const etbSantim = P2PCalc.calculateEtbTotalSantim(totalMicro, BigInt(config.referenceRateSantim));
      return P2PCalc.formatSantim(etbSantim);
    } catch {
      return '0.00';
    }
  }, [me, config?.referenceRateSantim]);

  const selectedOrder = useMemo(
    () => orders.find((o) => o.id === selectedOrderId) || orders[0] || null,
    [orders, selectedOrderId]
  );

  const copyText = async (txt: string, label: string) => {
    try {
      await navigator.clipboard.writeText(txt);
      setNotice(`Copied ${label}`);
    } catch {
      setNotice(`${label}: ${txt}`);
    }
  };

  const handleSaveServerUrl = (e: React.FormEvent) => {
    e.preventDefault();
    setStoredApiBase(serverUrlInput);
    setApiBase(serverUrlInput.trim().replace(/\/$/, ''));
    setShowServerModal(false);
    setNotice('Backend server URL updated');
  };

  const handleSwitchDevUser = async (tgId: string) => {
    setSelectedDevTgId(tgId);
    setSavedDevTgId(tgId);
    await onChangeDevUser(tgId);
  };

  const handlePostAd = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    try {
      await apiFetch('/api/ads', {
        initData,
        apiBase,
        method: 'POST',
        body: {
          direction: adDirection,
          usdtAmount: adAmount,
          priceEtb: adPrice,
          minOrderUsdt: adMin,
          maxOrderUsdt: adMax,
          paymentMethods: adMethods,
          paymentDetails: adPaymentDetails,
        },
      });
      setShowPostAd(false);
      setP2pDirection(adDirection);
      setNotice(`${adDirection} ad posted successfully`);
      await loadMarketplace();
    } catch (e: any) {
      setError(e?.message || 'Failed to post ad');
    }
  };

  const handleCancelAd = async (adId: number) => {
    setError('');
    try {
      await apiFetch(`/api/ads/${adId}/cancel`, { initData, apiBase, method: 'POST' });
      setNotice('Ad cancelled and remaining escrow unlocked');
      await loadMarketplace();
    } catch (e: any) {
      setError(e?.message || 'Unable to cancel ad');
    }
  };

  const openTradeModal = (ad: any) => {
    setTradeAd(ad);
    setTradeUsdt(ad.minOrderUsdt || '10');
    setTradeMethod(ad.paymentMethods?.[0] || 'Telebirr');
    setTradePayoutName(latestKyc?.full_name || `${me?.firstName || ''} ${me?.lastName || ''}`.trim());
    setTradePayoutId('');
    setTradePayoutFile(null);
  };

  const handleCreateOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tradeAd) return;
    setError('');
    setNotice('');
    try {
      let payoutProfileBase64: string | undefined;
      if (tradePayoutFile) {
        payoutProfileBase64 = await fileToDataUrl(tradePayoutFile);
      }
      const res = await apiFetch('/api/orders', {
        initData,
        apiBase,
        method: 'POST',
        body: {
          adId: tradeAd.id,
          usdtAmount: tradeUsdt,
          paymentMethod: tradeMethod,
          depositNetwork: tradeNetwork,
          payoutProvider: tradePayoutId && payoutProfileBase64 ? tradePayoutProvider : undefined,
          payoutAccountId: tradePayoutId && payoutProfileBase64 ? tradePayoutId : undefined,
          payoutAccountName: tradePayoutId && payoutProfileBase64 ? tradePayoutName : undefined,
          payoutProfileBase64,
        },
      });
      setTradeAd(null);
      setSelectedOrderId(res.order.id);
      setTab('orders');
      setNotice(`Order ${res.order.orderCode} created (15-min timer active)`);
      await loadMarketplace();
    } catch (e: any) {
      setError(e?.message || 'Order creation failed');
    }
  };

  const handleAttachOrderPayout = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrder) return;
    setError('');
    try {
      if (!ordPayoutFile) throw new Error('Upload Binance/Bybit profile screenshot first');
      const payoutProfileBase64 = await fileToDataUrl(ordPayoutFile);
      await apiFetch(`/api/orders/${selectedOrder.id}/payout-details`, {
        initData,
        apiBase,
        method: 'POST',
        body: {
          payoutProvider: ordPayoutProvider,
          payoutAccountId: ordPayoutId,
          payoutAccountName: ordPayoutName,
          payoutProfileBase64,
        },
      });
      setNotice('Payout account verified and saved. Proceed to ETB payment.');
      await loadMarketplace();
    } catch (e: any) {
      setError(e?.message || 'Failed to attach payout details');
    }
  };

  const handleMarkOrderPaid = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrder) return;
    setError('');
    try {
      if (!payFile) throw new Error('Attach ETB payment receipt screenshot');
      const paymentProofBase64 = await fileToDataUrl(payFile);
      await apiFetch(`/api/orders/${selectedOrder.id}/mark-paid`, {
        initData,
        apiBase,
        method: 'POST',
        body: {
          paymentRef: payRef,
          paymentProofBase64,
        },
      });
      setPayRef('');
      setPayFile(null);
      setNotice('Payment marked! Admin group has been alerted.');
      await loadMarketplace();
    } catch (e: any) {
      setError(e?.message || 'Failed to mark payment');
    }
  };

  const handleCancelOrder = async () => {
    if (!selectedOrder) return;
    setError('');
    try {
      await apiFetch(`/api/orders/${selectedOrder.id}/cancel`, {
        initData,
        apiBase,
        method: 'POST',
        body: { reason: 'Cancelled by user' },
      });
      setNotice(`Order ${selectedOrder.orderCode} cancelled`);
      await loadMarketplace();
    } catch (e: any) {
      setError(e?.message || 'Unable to cancel order');
    }
  };

  const handleOpenDispute = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrder) return;
    setError('');
    try {
      let evidenceBase64: string | undefined;
      if (disputeFile) evidenceBase64 = await fileToDataUrl(disputeFile);
      await apiFetch(`/api/orders/${selectedOrder.id}/dispute`, {
        initData,
        apiBase,
        method: 'POST',
        body: { reason: disputeReason, evidenceBase64 },
      });
      setShowDisputeBox(false);
      setDisputeReason('');
      setDisputeFile(null);
      setNotice('Order frozen in DISPUTED status for Admin review');
      await loadMarketplace();
    } catch (e: any) {
      setError(e?.message || 'Failed to open dispute');
    }
  };

  const handleSubmitRating = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrder) return;
    setError('');
    try {
      await apiFetch(`/api/orders/${selectedOrder.id}/rate`, {
        initData,
        apiBase,
        method: 'POST',
        body: { score: ratingScore, comment: ratingComment },
      });
      setNotice('Rating submitted');
      setRatingComment('');
      await loadMarketplace();
    } catch (e: any) {
      setError(e?.message || 'Failed to submit rating');
    }
  };

  const handleCreateDepositIntent = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const res = await apiFetch('/api/deposits/intent', {
        initData,
        apiBase,
        method: 'POST',
        body: { network: depNetwork, usdtAmount: depAmount },
      });
      setNotice(`Deposit intent ${res.intent.intent_code} created: send exact ${res.intent.uniqueUsdt} USDT`);
      await loadMarketplace();
    } catch (e: any) {
      setError(e?.message || 'Failed to create deposit intent');
    }
  };

  const handleVerifyDevPhone = async () => {
    setError('');
    try {
      await apiFetch('/api/kyc/verify-phone-dev', {
        initData,
        apiBase,
        method: 'POST',
        body: { phoneNumber: devPhoneInput },
      });
      setNotice('Verified phone saved (dev contact simulation)');
      await loadMarketplace();
    } catch (e: any) {
      setError(e?.message || 'Failed to verify phone');
    }
  };

  const handleSubmitKyc = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      if (!kycIdFrontFile || !kycSelfieFile) {
        throw new Error('Both ID front photo and selfie holding ID are required');
      }
      const [idFrontBase64, selfieBase64] = await Promise.all([
        fileToDataUrl(kycIdFrontFile),
        fileToDataUrl(kycSelfieFile),
      ]);
      await apiFetch('/api/kyc/submit', {
        initData,
        apiBase,
        method: 'POST',
        body: {
          fullName: kycName,
          nationalIdNumber: kycIdNumber,
          idFrontBase64,
          selfieBase64,
        },
      });
      setKycIdFrontFile(null);
      setKycSelfieFile(null);
      setNotice('KYC submitted! Status is PENDING admin review.');
      await loadMarketplace();
    } catch (e: any) {
      setError(e?.message || 'KYC submission failed');
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 pb-24">
      {/* Top Bar */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="font-bold text-sm sm:text-base tracking-tight text-slate-900 truncate">
              EthioP2P · USDT/ETB
            </div>
            <div className="text-[11px] text-slate-500 font-mono truncate">
              {config ? `${config.referenceRateEtb} ETB · ${config.commissionPercent}% fee` : 'Connecting...'}
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setLang(lang === 'bilingual' ? 'am' : 'bilingual')}
              className="px-2.5 py-1.5 text-xs font-semibold border border-slate-200 rounded-lg bg-white hover:bg-slate-50 whitespace-nowrap"
            >
              {lang === 'bilingual' ? 'አማ/EN' : 'አማርኛ'}
            </button>

            <button
              type="button"
              onClick={() => setShowServerModal(true)}
              aria-label="Configure backend server URL"
              className="p-2 border border-slate-200 rounded-lg bg-white hover:bg-slate-50 text-slate-700"
            >
              <Server className="w-4 h-4" />
            </button>

            {(me?.isAdmin || config?.devPreviewEnabled) && (
              <button
                type="button"
                onClick={onOpenAdmin}
                className="px-2.5 py-1.5 text-xs font-semibold bg-slate-900 text-white rounded-lg hover:bg-slate-800 whitespace-nowrap"
              >
                Admin
              </button>
            )}

            <button
              type="button"
              onClick={loadMarketplace}
              disabled={loading}
              aria-label="Refresh marketplace"
              className="p-2 border border-slate-200 rounded-lg bg-white hover:bg-slate-50 text-slate-700"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Dev Preview User Switcher (ONLY shown outside Telegram when devPreviewEnabled) */}
        {config?.devPreviewEnabled && !isTelegramEnv && previewUsers.length > 0 && (
          <div className="max-w-3xl mx-auto px-4 py-2 bg-amber-50/70 border-t border-amber-200/70 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-semibold text-amber-900">Dev Preview Session (HMAC signed)</span>
            <select
              aria-label="Switch preview Telegram user"
              value={selectedDevTgId}
              onChange={(e) => handleSwitchDevUser(e.target.value)}
              className="px-2.5 py-1 bg-white border border-amber-300 rounded-md text-xs font-medium text-slate-900"
            >
              {previewUsers.map((u) => (
                <option key={u.telegram_id} value={u.telegram_id}>
                  {u.first_name} {u.last_name} ({u.telegram_id}) — KYC: {u.kyc_status}
                </option>
              ))}
            </select>
          </div>
        )}
      </header>

      <main className="max-w-3xl mx-auto px-4 pt-4 space-y-4">
        {!initData && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-900">
            Open inside Telegram Mini App to authenticate automatically with your Telegram WebApp signature.
          </div>
        )}

        {me?.isSuspended && (
          <div className="bg-rose-50 border border-rose-300 rounded-xl p-4 text-xs text-rose-900 flex items-start gap-2.5">
            <ShieldAlert className="w-4 h-4 text-rose-700 shrink-0 mt-0.5" />
            <div>
              <div className="font-bold">Account Suspended / መለያ ታግዷል</div>
              <div className="mt-0.5">{me.suspendedReason || 'Repeated disputes exceeded limit. Contact admin.'}</div>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 text-xs font-medium text-rose-800">
            {error}
          </div>
        )}
        {notice && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-xs font-medium text-emerald-900 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-700" />
            <span>{notice}</span>
          </div>
        )}

        {/* ── TAB 1: HOME ───────────────────────────────────── */}
        {tab === 'home' && me && (
          <div className="space-y-4">
            <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-xs font-medium text-slate-500">
                    {t('Available Escrow Balance', 'ዝግጁ USDT ቀሪ ሂሳብ')}
                  </div>
                  <div className="text-2xl sm:text-3xl font-bold font-mono tabular-nums text-slate-900 mt-1">
                    {me.availableUsdt} USDT
                  </div>
                  <div className="text-xs text-slate-500 font-mono tabular-nums mt-1">
                    Locked Escrow: {me.lockedUsdt} USDT · ≈ {homeEtbApprox} ETB
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] text-slate-500">KYC</div>
                  <div
                    className={`text-xs font-bold ${
                      me.kycStatus === 'APPROVED'
                        ? 'text-emerald-700'
                        : me.kycStatus === 'REJECTED'
                        ? 'text-rose-700'
                        : 'text-amber-700'
                    }`}
                  >
                    {me.kycStatus}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setTab('p2p')}
                  className="py-2.5 px-4 bg-slate-900 text-white rounded-lg text-xs sm:text-sm font-semibold hover:bg-slate-800"
                >
                  {t('Trade P2P', 'P2P ግብይት')}
                </button>
                <button
                  type="button"
                  onClick={() => setTab('wallets')}
                  className="py-2.5 px-4 bg-white border border-slate-300 text-slate-900 rounded-lg text-xs sm:text-sm font-semibold hover:bg-slate-50"
                >
                  {t('Deposit USDT', 'USDT አስገባ')}
                </button>
              </div>
            </section>

            {me.kycStatus !== 'APPROVED' && (
              <section className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-1">
                  <div className="text-sm font-bold text-amber-950">
                    {t('Verification Required to Trade', 'ለመገበያየት KYC ማረጋገጫ ያስፈልጋል')}
                  </div>
                  <p className="text-xs text-amber-900">
                    {me.kycStatus === 'PENDING'
                      ? 'Your KYC is pending admin approval.'
                      : 'Complete phone contact share and ID verification before posting ads or creating orders.'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setTab('profile')}
                  className="px-3.5 py-2 bg-amber-700 text-white text-xs font-semibold rounded-lg hover:bg-amber-800 whitespace-nowrap"
                >
                  {t('Verify Now', 'አሁን ያረጋግጡ')}
                </button>
              </section>
            )}

            {dailyLimit && (
              <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-700">
                    {t('Daily Limit (24h)', 'የዕለት ገደብ')}
                  </span>
                  <span className="font-mono tabular-nums text-slate-900 font-semibold">
                    {dailyLimit.usedUsdt} / {dailyLimit.limitUsdt} USDT
                  </span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-600"
                    style={{
                      width: `${Math.min(
                        100,
                        dailyLimit.limitMicroUsdt > 0
                          ? Math.round((dailyLimit.usedMicroUsdt / dailyLimit.limitMicroUsdt) * 100)
                          : 0
                      )}%`,
                    }}
                  />
                </div>
                <div className="text-[11px] text-slate-500">
                  Remaining today: <span className="font-mono">{dailyLimit.remainingUsdt} USDT</span> ·{' '}
                  Price Guard: ±10% ({config?.priceGuardBounds?.minEtb} – {config?.priceGuardBounds?.maxEtb} ETB)
                </div>
              </section>
            )}

            <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-slate-900">{t('Recent Orders', 'የቅርብ ጊዜ ትዕዛዞች')}</h2>
                <button
                  type="button"
                  onClick={() => setTab('orders')}
                  className="text-xs font-semibold text-slate-600 hover:text-slate-900"
                >
                  View all →
                </button>
              </div>
              {orders.length === 0 ? (
                <div className="text-xs text-slate-500 py-3">No orders yet. Visit P2P tab to start a trade.</div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {orders.slice(0, 4).map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => {
                        setSelectedOrderId(o.id);
                        setTab('orders');
                      }}
                      className="w-full py-2.5 flex items-center justify-between text-left hover:bg-slate-50 rounded-md px-1"
                    >
                      <div>
                        <div className="font-mono text-xs font-bold text-slate-900">
                          {o.orderCode} · {o.grossUsdt} USDT
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {o.paymentMethod} · {o.etbTotal} ETB
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-xs font-semibold text-slate-800">{o.status}</div>
                        <OrderCountdown expiresAt={o.expiresAt} serverOffsetMs={serverOffsetMs} status={o.status} />
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {/* ── TAB 2: P2P MARKETPLACE ────────────────────────── */}
        {tab === 'p2p' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex bg-slate-200/80 p-1 rounded-lg">
                <button
                  type="button"
                  data-testid="tab-sell-ads"
                  onClick={() => setP2pDirection('SELL')}
                  className={`px-4 py-1.5 rounded-md text-xs font-bold transition-colors ${
                    p2pDirection === 'SELL' ? 'bg-amber-600 text-white' : 'text-slate-700'
                  }`}
                >
                  {t('SELL Ads', 'የሽያጭ ማስታወቂያ (SELL)')}
                </button>
                <button
                  type="button"
                  data-testid="tab-buy-ads"
                  onClick={() => setP2pDirection('BUY')}
                  className={`px-4 py-1.5 rounded-md text-xs font-bold transition-colors ${
                    p2pDirection === 'BUY' ? 'bg-emerald-600 text-white' : 'text-slate-700'
                  }`}
                >
                  {t('BUY Ads', 'የግዢ ማስታወቂያ (BUY)')}
                </button>
              </div>

              <button
                type="button"
                onClick={() => {
                  setAdDirection(p2pDirection);
                  if (config?.referenceRateEtb) setAdPrice(config.referenceRateEtb);
                  setShowPostAd(!showPostAd);
                }}
                className="px-3.5 py-2 bg-slate-900 text-white text-xs font-semibold rounded-lg hover:bg-slate-800 flex items-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" /> {t('Post Ad', 'ማስታወቂያ ለጥፍ')}
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {['ALL', ...PAYMENT_OPTIONS].map((pm) => (
                <button
                  key={pm}
                  type="button"
                  onClick={() => setPaymentFilter(pm)}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-lg border whitespace-nowrap ${
                    paymentFilter === pm
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {pm}
                </button>
              ))}
            </div>

            {/* Post Ad Drawer */}
            {showPostAd && (
              <form onSubmit={handlePostAd} className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-slate-900">{t('Create New Ad', 'አዲስ ማስታወቂያ')}</h3>
                  <button
                    type="button"
                    onClick={() => setShowPostAd(false)}
                    className="text-xs text-slate-500 hover:text-slate-900"
                  >
                    Close
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setAdDirection('SELL')}
                    className={`py-2 text-xs font-bold rounded-lg border ${
                      adDirection === 'SELL'
                        ? 'bg-amber-50 border-amber-500 text-amber-900'
                        : 'bg-white border-slate-200 text-slate-600'
                    }`}
                  >
                    SELL USDT (Locks Escrow)
                  </button>
                  <button
                    type="button"
                    onClick={() => setAdDirection('BUY')}
                    className={`py-2 text-xs font-bold rounded-lg border ${
                      adDirection === 'BUY'
                        ? 'bg-emerald-50 border-emerald-500 text-emerald-900'
                        : 'bg-white border-slate-200 text-slate-600'
                    }`}
                  >
                    BUY USDT
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">USDT Amount</label>
                    <input
                      type="text"
                      value={adAmount}
                      onChange={(e) => setAdAmount(e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Price ETB / USDT (±10%: {config?.priceGuardBounds?.minEtb}–{config?.priceGuardBounds?.maxEtb})
                    </label>
                    <input
                      type="text"
                      value={adPrice}
                      onChange={(e) => setAdPrice(e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Min Order (USDT)</label>
                    <input
                      type="text"
                      value={adMin}
                      onChange={(e) => setAdMin(e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Max Order (USDT)</label>
                    <input
                      type="text"
                      value={adMax}
                      onChange={(e) => setAdMax(e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>

                <div>
                  <div className="text-xs font-semibold text-slate-700 mb-1.5">Payment Methods</div>
                  <div className="flex flex-wrap gap-2">
                    {PAYMENT_OPTIONS.map((m) => {
                      const checked = adMethods.includes(m);
                      return (
                        <label key={m} className="flex items-center gap-1.5 text-xs bg-slate-50 px-2.5 py-1.5 rounded-md border border-slate-200">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) =>
                              setAdMethods(e.target.checked ? [...adMethods, m] : adMethods.filter((x) => x !== m))
                            }
                          />
                          {m}
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Payment Instructions / Account Details
                  </label>
                  <input
                    type="text"
                    value={adPaymentDetails}
                    onChange={(e) => setAdPaymentDetails(e.target.value)}
                    placeholder="e.g. Telebirr 0911223344 / CBE 1000123456789"
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  />
                </div>

                {postAdPreview && (
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <div>
                      <div className="text-slate-500">Gross</div>
                      <div className="font-mono font-bold">{postAdPreview.grossUsdt} USDT</div>
                    </div>
                    <div>
                      <div className="text-slate-500">Seller Fee ({postAdPreview.commissionPercent}%)</div>
                      <div className="font-mono font-bold">{postAdPreview.feeUsdt} USDT</div>
                    </div>
                    <div>
                      <div className="text-slate-500">Net USDT</div>
                      <div className="font-mono font-bold text-emerald-700">{postAdPreview.netUsdt} USDT</div>
                    </div>
                    <div>
                      <div className="text-slate-500">ETB Total</div>
                      <div className="font-mono font-bold">{postAdPreview.etbTotal} ETB</div>
                    </div>
                  </div>
                )}

                <button
                  type="submit"
                  className="w-full py-2.5 bg-slate-900 text-white text-xs font-semibold rounded-lg hover:bg-slate-800"
                >
                  Publish {adDirection} Ad
                </button>
              </form>
            )}

            {/* Ads List (Strict direction match) */}
            <div className="space-y-3" data-testid="ads-list">
              {ads.length === 0 ? (
                <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
                  No active {p2pDirection} ads available right now.
                </div>
              ) : (
                ads.map((ad) => (
                  <article
                    key={ad.id}
                    data-ad-direction={ad.direction}
                    className="bg-white border border-slate-200 rounded-xl p-4 space-y-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-sm text-slate-900">{ad.creatorName}</span>
                          <span
                            className={`text-[11px] font-bold font-mono ${
                              ad.direction === 'SELL' ? 'text-amber-700' : 'text-emerald-700'
                            }`}
                          >
                            {ad.direction}
                          </span>
                          {ad.creatorRating && (
                            <span className="text-xs text-slate-500 flex items-center gap-0.5">
                              <Star className="w-3 h-3 text-amber-500 fill-amber-500" /> {ad.creatorRating}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          Available: <span className="font-mono font-semibold text-slate-900">{ad.remainingUsdt} USDT</span>{' '}
                          · Limits: <span className="font-mono">{ad.minOrderUsdt}–{ad.maxOrderUsdt} USDT</span>
                        </div>
                      </div>

                      <div className="text-right">
                        <div className="text-lg font-bold font-mono tabular-nums text-slate-900">
                          {ad.priceEtb} <span className="text-xs font-normal text-slate-500">ETB</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100">
                      <div className="text-xs text-slate-600">{ad.paymentMethods.join(' · ')}</div>
                      {me?.id === ad.userId ? (
                        <button
                          type="button"
                          onClick={() => handleCancelAd(ad.id)}
                          className="px-3 py-1.5 text-xs font-semibold text-rose-700 border border-rose-200 rounded-lg hover:bg-rose-50"
                        >
                          Cancel My Ad
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => openTradeModal(ad)}
                          className={`px-4 py-2 text-xs font-semibold text-white rounded-lg ${
                            ad.direction === 'SELL'
                              ? 'bg-emerald-600 hover:bg-emerald-700'
                              : 'bg-amber-600 hover:bg-amber-700'
                          }`}
                        >
                          {ad.direction === 'SELL' ? t('Buy USDT', 'USDT ግዛ') : t('Sell USDT', 'USDT ሽጥ')}
                        </button>
                      )}
                    </div>
                  </article>
                ))
              )}
            </div>

            {myAds.length > 0 && (
              <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
                <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wide">My Posted Ads</h3>
                <div className="divide-y divide-slate-100">
                  {myAds.map((a) => (
                    <div key={a.id} className="py-2 flex items-center justify-between text-xs">
                      <div>
                        <span className="font-bold">{a.direction}</span> ·{' '}
                        <span className="font-mono">
                          {a.remainingUsdt}/{a.totalUsdt} USDT
                        </span>{' '}
                        @ <span className="font-mono">{a.priceEtb} ETB</span> ·{' '}
                        <span className="text-slate-500">{a.status}</span>
                      </div>
                      {a.status === 'ACTIVE' && (
                        <button
                          type="button"
                          onClick={() => handleCancelAd(a.id)}
                          className="text-rose-700 font-semibold hover:underline"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {/* ── TAB 3: WALLETS & DEPOSIT MATCHING ─────────────── */}
        {tab === 'wallets' && me && (
          <div className="space-y-4">
            <section className="bg-rose-50 border border-rose-200 rounded-xl p-4 flex items-start gap-2.5 text-xs text-rose-900">
              <AlertTriangle className="w-4 h-4 text-rose-700 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="font-bold">
                  Wrong-Network Warning / የተሳሳተ ኔትወርክ ማስጠንቀቂያ
                </div>
                <p>
                  Only deposit USDT on your selected network (TRC20 or BEP20). Sending ERC20 or mismatched tokens results in permanent loss. Always send the exact unique 4-decimal USDT amount so our matching engine credits your wallet.
                </p>
              </div>
            </section>

            <form onSubmit={handleCreateDepositIntent} className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <h2 className="text-sm font-bold text-slate-900">
                {t('Create Unique-Amount Deposit', 'ልዩ መጠን ያለው USDT ማስገቢያ')}
              </h2>

              <div className="grid grid-cols-2 gap-2">
                {(['TRC20', 'BEP20'] as const).map((net) => (
                  <button
                    key={net}
                    type="button"
                    onClick={() => setDepNetwork(net)}
                    className={`py-2 px-3 rounded-lg text-xs font-bold border ${
                      depNetwork === net
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-700 border-slate-200'
                    }`}
                  >
                    {net === 'TRC20' ? 'TRC20 (TRON)' : 'BEP20 (BNB Smart Chain)'}
                  </button>
                ))}
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex items-center justify-between gap-2 text-xs">
                <div className="min-w-0">
                  <div className="text-slate-500">{depNetwork} Escrow Deposit Address</div>
                  <div className="font-mono font-semibold text-slate-900 break-all">
                    {config?.depositAddresses?.[depNetwork] || '...'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => copyText(config?.depositAddresses?.[depNetwork] || '', `${depNetwork} address`)}
                  className="px-2.5 py-1.5 bg-white border border-slate-300 rounded-md font-semibold flex items-center gap-1 shrink-0"
                >
                  <Copy className="w-3.5 h-3.5" /> Copy
                </button>
              </div>

              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={depAmount}
                  onChange={(e) => setDepAmount(e.target.value)}
                  placeholder="Amount (USDT)"
                  className="w-full min-w-0 sm:flex-1 px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                />
                <button
                  type="submit"
                  className="w-full sm:w-auto px-4 py-2.5 bg-emerald-600 text-white text-xs font-semibold rounded-lg hover:bg-emerald-700 whitespace-nowrap"
                >
                  Generate Unique Amount
                </button>
              </div>
            </form>

            {deposits.length > 0 && (
              <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-2.5">
                <h3 className="text-sm font-bold text-slate-900">Your Deposit Intents</h3>
                <div className="space-y-2">
                  {deposits.map((d) => (
                    <div key={d.id} className="border border-slate-200 rounded-lg p-3 text-xs space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="font-mono font-bold">
                          {d.intent_code} · {d.network}
                        </span>
                        <span className={`font-bold ${d.status === 'MATCHED' ? 'text-emerald-700' : 'text-amber-700'}`}>
                          {d.status}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Send exact unique amount:</span>
                        <button
                          type="button"
                          onClick={() => copyText(d.uniqueUsdt, 'unique USDT amount')}
                          className="font-mono font-bold text-slate-900 flex items-center gap-1"
                        >
                          {d.uniqueUsdt} USDT <Copy className="w-3 h-3" />
                        </button>
                      </div>
                      <div className="font-mono text-[11px] text-slate-500 break-all">To: {d.deposit_address}</div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <h3 className="text-sm font-bold text-slate-900">{t('Append-Only Escrow Ledger', 'የሂሳብ መዝገብ')}</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <tr>
                      <th className="p-2">Reason</th>
                      <th className="p-2 text-right">Available Δ</th>
                      <th className="p-2 text-right">Locked Δ</th>
                      <th className="p-2">Time</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {ledger.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="p-4 text-center text-slate-500">
                          No ledger entries yet.
                        </td>
                      </tr>
                    ) : (
                      ledger.map((l) => (
                        <tr key={l.id}>
                          <td className="p-2 font-mono">{l.reason}</td>
                          <td className="p-2 text-right font-mono tabular-nums">
                            {l.availableDeltaSign}
                            {l.availableDeltaUsdt}
                          </td>
                          <td className="p-2 text-right font-mono tabular-nums">
                            {l.lockedDeltaSign}
                            {l.lockedDeltaUsdt}
                          </td>
                          <td className="p-2 text-slate-500">{new Date(l.created_at).toLocaleTimeString()}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}

        {/* ── TAB 4: ORDERS & 15-MIN FLOW ───────────────────── */}
        {tab === 'orders' && me && (
          <div className="space-y-4">
            {orders.length === 0 ? (
              <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
                No orders yet. Visit P2P to take an ad.
              </div>
            ) : (
              <>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {orders.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => setSelectedOrderId(o.id)}
                      className={`px-3 py-2 rounded-lg border text-xs font-mono whitespace-nowrap ${
                        selectedOrder?.id === o.id
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-700 border-slate-200'
                      }`}
                    >
                      {o.orderCode} ({o.status})
                    </button>
                  ))}
                </div>

                {selectedOrder && (
                  <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="font-mono font-bold text-base text-slate-900">
                          {selectedOrder.orderCode}
                        </div>
                        <div className="text-xs text-slate-500">
                          {selectedOrder.buyerUserId === me.id ? 'You are BUYER (Pay ETB, Receive USDT)' : 'You are SELLER (Receive ETB)'}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-xs font-bold text-slate-900">{selectedOrder.status}</div>
                        <OrderCountdown
                          expiresAt={selectedOrder.expiresAt}
                          serverOffsetMs={serverOffsetMs}
                          status={selectedOrder.status}
                        />
                      </div>
                    </div>

                    <OrderStatusTimeline status={selectedOrder.status} />

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs">
                      <div>
                        <div className="text-slate-500">Gross USDT</div>
                        <div className="font-mono tabular-nums font-bold">{selectedOrder.grossUsdt} USDT</div>
                      </div>
                      <div>
                        <div className="text-slate-500">Fee ({selectedOrder.commissionPercent}%)</div>
                        <div className="font-mono tabular-nums font-bold">{selectedOrder.feeUsdt} USDT</div>
                      </div>
                      <div>
                        <div className="text-slate-500">Net USDT Payout</div>
                        <div className="font-mono tabular-nums font-bold text-emerald-700">{selectedOrder.netUsdt} USDT</div>
                      </div>
                      <div>
                        <div className="text-slate-500">ETB Total</div>
                        <div className="font-mono tabular-nums font-bold">{selectedOrder.etbTotal} ETB</div>
                      </div>
                    </div>

                    <div className="text-xs space-y-1 text-slate-700 bg-slate-50 rounded-lg p-3">
                      <div>
                        Payment Method: <strong>{selectedOrder.paymentMethod}</strong> · Details:{' '}
                        <span className="font-mono">{selectedOrder.paymentDetails || 'Check with seller'}</span>
                      </div>
                      <div>
                        Unique Match Amount ({selectedOrder.depositNetwork}):{' '}
                        <span className="font-mono font-semibold">{selectedOrder.uniqueMatchUsdt} USDT</span>
                      </div>
                      {selectedOrder.payoutAccountId && (
                        <div>
                          Receiver Payout Target: <strong>{selectedOrder.payoutProvider}</strong>{' '}
                          <span className="font-mono">{selectedOrder.payoutAccountId}</span> ({selectedOrder.payoutAccountName})
                        </div>
                      )}
                    </div>

                    {/* Step 1: Buyer attaches KYC-matched Binance Pay / Bybit UID when CREATED */}
                    {selectedOrder.status === 'CREATED' && selectedOrder.buyerUserId === me.id && (
                      <form onSubmit={handleAttachOrderPayout} className="border border-amber-200 bg-amber-50/50 rounded-xl p-4 space-y-3">
                        <div className="text-xs font-bold text-amber-950">
                          Step 1: Set Receiver Binance Pay ID / Bybit UID (Account Name Must Match KYC)
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <select
                            value={ordPayoutProvider}
                            onChange={(e) => setOrdPayoutProvider(e.target.value as 'BINANCE_PAY' | 'BYBIT_UID')}
                            className="px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                          >
                            <option value="BINANCE_PAY">Binance Pay ID</option>
                            <option value="BYBIT_UID">Bybit UID</option>
                          </select>
                          <input
                            type="text"
                            required
                            value={ordPayoutId}
                            onChange={(e) => setOrdPayoutId(e.target.value)}
                            placeholder="Binance Pay ID or Bybit UID"
                            className="px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg font-mono"
                          />
                        </div>
                        <input
                          type="text"
                          required
                          value={ordPayoutName}
                          onChange={(e) => setOrdPayoutName(e.target.value)}
                          placeholder={`Full name matching KYC (${latestKyc?.full_name || me.firstName})`}
                          className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                        />
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                            Upload Binance/Bybit Profile Screenshot
                          </label>
                          <input
                            type="file"
                            required
                            accept="image/png,image/jpeg,image/webp"
                            onChange={(e) => setOrdPayoutFile(e.target.files?.[0] || null)}
                            className="text-xs"
                          />
                        </div>
                        <button
                          type="submit"
                          className="px-4 py-2 bg-slate-900 text-white text-xs font-semibold rounded-lg hover:bg-slate-800"
                        >
                          Save Payout Details → AWAITING PAYMENT
                        </button>
                      </form>
                    )}

                    {/* Step 2: Buyer marks paid when AWAITING_PAYMENT */}
                    {selectedOrder.status === 'AWAITING_PAYMENT' && selectedOrder.buyerUserId === me.id && (
                      <form onSubmit={handleMarkOrderPaid} className="border border-emerald-200 bg-emerald-50/40 rounded-xl p-4 space-y-3">
                        <div className="text-xs font-bold text-emerald-950">
                          Step 2: Send {selectedOrder.etbTotal} ETB via {selectedOrder.paymentMethod} & Upload Proof
                        </div>
                        <input
                          type="text"
                          required
                          value={payRef}
                          onChange={(e) => setPayRef(e.target.value)}
                          placeholder="Transaction Reference ID (e.g. TELEBIRR-99201)"
                          className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg font-mono"
                        />
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                            Payment Receipt Screenshot
                          </label>
                          <input
                            type="file"
                            required
                            accept="image/png,image/jpeg,image/webp"
                            onChange={(e) => setPayFile(e.target.files?.[0] || null)}
                            className="text-xs"
                          />
                        </div>
                        <button
                          type="submit"
                          className="px-4 py-2 bg-emerald-600 text-white text-xs font-semibold rounded-lg hover:bg-emerald-700"
                        >
                          Mark as Paid / ተከፍሏል
                        </button>
                      </form>
                    )}

                    {/* Private Proofs Display */}
                    {(selectedOrder.paymentProofFileId || selectedOrder.payoutProofFileId) && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {selectedOrder.paymentProofFileId && (
                          <div>
                            <div className="text-[11px] font-medium text-slate-500 mb-1">ETB Payment Proof</div>
                            <PrivateImage
                              fileId={selectedOrder.paymentProofFileId}
                              alt="ETB Payment Proof"
                              initData={initData}
                              className="w-full h-36"
                            />
                          </div>
                        )}
                        {selectedOrder.payoutProofFileId && (
                          <div>
                            <div className="text-[11px] font-medium text-slate-500 mb-1">
                              Admin USDT Payout Proof ({selectedOrder.payoutRef})
                            </div>
                            <PrivateImage
                              fileId={selectedOrder.payoutProofFileId}
                              alt="USDT Payout Proof"
                              initData={initData}
                              className="w-full h-36"
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {/* Cancel & Dispute buttons */}
                    <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-100">
                      {(selectedOrder.status === 'CREATED' || selectedOrder.status === 'AWAITING_PAYMENT') && (
                        <button
                          type="button"
                          onClick={handleCancelOrder}
                          className="px-3.5 py-2 border border-slate-300 text-slate-700 text-xs font-semibold rounded-lg hover:bg-slate-50"
                        >
                          Cancel Order
                        </button>
                      )}
                      {(selectedOrder.status === 'AWAITING_PAYMENT' || selectedOrder.status === 'PAID_MARKED') && (
                        <button
                          type="button"
                          onClick={() => setShowDisputeBox(!showDisputeBox)}
                          className="px-3.5 py-2 border border-rose-300 text-rose-700 text-xs font-semibold rounded-lg hover:bg-rose-50"
                        >
                          Open Dispute
                        </button>
                      )}
                    </div>

                    {showDisputeBox && (
                      <form onSubmit={handleOpenDispute} className="bg-rose-50 border border-rose-200 rounded-lg p-3 space-y-2">
                        <input
                          type="text"
                          required
                          value={disputeReason}
                          onChange={(e) => setDisputeReason(e.target.value)}
                          placeholder="Describe the issue clearly..."
                          className="w-full px-3 py-2 text-xs bg-white border border-rose-300 rounded-lg"
                        />
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          onChange={(e) => setDisputeFile(e.target.files?.[0] || null)}
                          className="text-xs"
                        />
                        <button
                          type="submit"
                          className="px-3.5 py-1.5 bg-rose-600 text-white text-xs font-semibold rounded-lg"
                        >
                          Freeze Order & Submit Dispute
                        </button>
                      </form>
                    )}

                    {/* Rating after RELEASED */}
                    {selectedOrder.status === 'RELEASED' && !selectedOrder.myRatingScore && (
                      <form onSubmit={handleSubmitRating} className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
                        <div className="text-xs font-bold text-slate-900">Rate Counterparty (1–5 Stars)</div>
                        <div className="flex items-center gap-2">
                          {[1, 2, 3, 4, 5].map((s) => (
                            <button
                              key={s}
                              type="button"
                              onClick={() => setRatingScore(s)}
                              className={`px-2.5 py-1 text-xs rounded border font-semibold ${
                                ratingScore >= s
                                  ? 'bg-amber-500 text-white border-amber-500'
                                  : 'bg-white text-slate-600 border-slate-300'
                              }`}
                            >
                              {s} ★
                            </button>
                          ))}
                        </div>
                        <input
                          type="text"
                          value={ratingComment}
                          onChange={(e) => setRatingComment(e.target.value)}
                          placeholder="Optional feedback"
                          className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                        />
                        <button
                          type="submit"
                          className="px-3.5 py-1.5 bg-slate-900 text-white text-xs font-semibold rounded-lg"
                        >
                          Submit Rating
                        </button>
                      </form>
                    )}
                  </section>
                )}
              </>
            )}
          </div>
        )}

        {/* ── TAB 5: PROFILE & KYC ──────────────────────────── */}
        {tab === 'profile' && me && (
          <div className="space-y-4">
            <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-bold text-slate-900">
                    {me.firstName} {me.lastName}
                  </h2>
                  <div className="text-xs text-slate-500 font-mono">
                    TG ID: {me.telegramId} {me.username ? `· @${me.username}` : ''}
                  </div>
                </div>
                <span
                  className={`text-xs font-bold ${
                    me.kycStatus === 'APPROVED'
                      ? 'text-emerald-700'
                      : me.kycStatus === 'REJECTED'
                      ? 'text-rose-700'
                      : 'text-amber-700'
                  }`}
                >
                  KYC: {me.kycStatus}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs bg-slate-50 p-3 rounded-lg">
                <div>
                  <div className="text-slate-500">Phone Verified</div>
                  <div className="font-mono font-semibold text-slate-900">
                    {me.phoneVerified ? `YES (${me.phoneNumber})` : 'NO (Run /start in bot)'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Trader Rating</div>
                  <div className="font-mono font-semibold text-slate-900">
                    {me.avgRating ? `${me.avgRating} ★ (${me.ratingCount})` : 'No ratings yet'}
                  </div>
                </div>
              </div>

              {latestKyc?.rejection_reason && me.kycStatus === 'REJECTED' && (
                <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 text-xs text-rose-800">
                  <strong>Rejection Reason:</strong> {latestKyc.rejection_reason}
                </div>
              )}

              {config?.botUsername && (
                <a
                  href={`https://t.me/${config.botUsername}?start=kyc`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-900 underline"
                >
                  Open @{config.botUsername} (/start Contact & Bot KYC) <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}
            </section>

            {!me.phoneVerified && config?.devPreviewEnabled && (
              <section className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-2">
                <div className="text-xs font-bold text-amber-950">
                  Dev Preview: Simulate Telegram /start Contact Share
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={devPhoneInput}
                    onChange={(e) => setDevPhoneInput(e.target.value)}
                    className="flex-1 px-3 py-2 text-xs bg-white border border-amber-300 rounded-lg font-mono"
                  />
                  <button
                    type="button"
                    onClick={handleVerifyDevPhone}
                    className="px-3.5 py-2 bg-amber-700 text-white text-xs font-semibold rounded-lg"
                  >
                    Verify Phone
                  </button>
                </div>
              </section>
            )}

            {me.phoneVerified && (me.kycStatus === 'NONE' || me.kycStatus === 'REJECTED') && (
              <form onSubmit={handleSubmitKyc} className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
                <h3 className="text-sm font-bold text-slate-900">
                  {me.kycStatus === 'REJECTED'
                    ? t('Resubmit KYC Documents', 'KYC እንደገና ያስገቡ')
                    : t('Submit KYC Verification', 'የማንነት ማረጋገጫ (KYC) ያስገቡ')}
                </h3>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Full Name (Matches Bank & Exchange)</label>
                  <input
                    type="text"
                    required
                    value={kycName}
                    onChange={(e) => setKycName(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">National ID / Passport Number</label>
                  <input
                    type="text"
                    required
                    value={kycIdNumber}
                    onChange={(e) => setKycIdNumber(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">ID Front Photo (Private)</label>
                  <input
                    type="file"
                    required
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(e) => setKycIdFrontFile(e.target.files?.[0] || null)}
                    className="text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Selfie Holding ID (Private)</label>
                  <input
                    type="file"
                    required
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(e) => setKycSelfieFile(e.target.files?.[0] || null)}
                    className="text-xs"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full py-2.5 bg-slate-900 text-white text-xs font-semibold rounded-lg hover:bg-slate-800"
                >
                  Submit KYC for Admin Review
                </button>
              </form>
            )}
          </div>
        )}
      </main>

      {/* Trade Modal */}
      {tradeAd && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <form
            onSubmit={handleCreateOrder}
            className="w-full max-w-md bg-white rounded-t-2xl sm:rounded-2xl p-5 space-y-3 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900">
                {tradeAd.direction === 'SELL' ? 'Buy USDT' : 'Sell USDT'} — {tradeAd.creatorName}
              </h3>
              <button type="button" onClick={() => setTradeAd(null)} className="text-xs text-slate-500">
                Close
              </button>
            </div>

            <div className="text-xs text-slate-600">
              Rate: <strong className="font-mono">{tradeAd.priceEtb} ETB/USDT</strong> · Limit:{' '}
              <span className="font-mono">
                {tradeAd.minOrderUsdt}–{tradeAd.maxOrderUsdt} USDT
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">USDT Amount</label>
                <input
                  type="text"
                  required
                  value={tradeUsdt}
                  onChange={(e) => setTradeUsdt(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Payment Method</label>
                <select
                  value={tradeMethod}
                  onChange={(e) => setTradeMethod(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  {tradeAd.paymentMethods.map((m: string) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Network Preference</label>
              <select
                value={tradeNetwork}
                onChange={(e) => setTradeNetwork(e.target.value as 'TRC20' | 'BEP20')}
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
              >
                <option value="TRC20">TRC20 (TRON)</option>
                <option value="BEP20">BEP20 (BNB Smart Chain)</option>
              </select>
            </div>

            {tradePreview && (
              <div data-testid="trade-live-preview" className="bg-slate-50 border border-slate-200 rounded-xl p-3 grid grid-cols-2 gap-2 text-xs">
                <div>
                  <div className="text-slate-500">Gross USDT</div>
                  <div className="font-mono tabular-nums font-bold">{tradePreview.grossUsdt} USDT</div>
                </div>
                <div>
                  <div className="text-slate-500">Fee ({tradePreview.commissionPercent}% seller pays)</div>
                  <div className="font-mono tabular-nums font-bold">{tradePreview.feeUsdt} USDT</div>
                </div>
                <div>
                  <div className="text-slate-500">Net USDT Payout</div>
                  <div className="font-mono tabular-nums font-bold text-emerald-700">{tradePreview.netUsdt} USDT</div>
                </div>
                <div>
                  <div className="text-slate-500">ETB Total</div>
                  <div className="font-mono tabular-nums font-bold">{tradePreview.etbTotal} ETB</div>
                </div>
              </div>
            )}

            {tradeAd.direction === 'SELL' && (
              <div className="border-t border-slate-100 pt-2 space-y-2">
                <div className="text-[11px] font-semibold text-slate-600">
                  Optional: Attach Receiver Binance Pay / Bybit UID now (or later in Orders tab)
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={tradePayoutProvider}
                    onChange={(e) => setTradePayoutProvider(e.target.value as 'BINANCE_PAY' | 'BYBIT_UID')}
                    className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="BINANCE_PAY">Binance Pay</option>
                    <option value="BYBIT_UID">Bybit UID</option>
                  </select>
                  <input
                    type="text"
                    value={tradePayoutId}
                    onChange={(e) => setTradePayoutId(e.target.value)}
                    placeholder="Pay ID / UID"
                    className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg font-mono"
                  />
                </div>
                {tradePayoutId && (
                  <>
                    <input
                      type="text"
                      value={tradePayoutName}
                      onChange={(e) => setTradePayoutName(e.target.value)}
                      placeholder="Account name (must match KYC)"
                      className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
                    />
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(e) => setTradePayoutFile(e.target.files?.[0] || null)}
                      className="text-xs"
                    />
                  </>
                )}
              </div>
            )}

            <button
              type="submit"
              className="w-full py-2.5 bg-slate-900 text-white text-xs font-semibold rounded-lg hover:bg-slate-800"
            >
              Confirm & Start 15-Min Order
            </button>
          </form>
        </div>
      )}

      {/* Backend Server URL Modal */}
      {showServerModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <form onSubmit={handleSaveServerUrl} className="w-full max-w-md bg-white rounded-xl p-5 space-y-3">
            <h3 className="text-sm font-bold text-slate-900">Backend Server URL (Render / Alet Cloud)</h3>
            <p className="text-xs text-slate-500">
              Leave empty for same-origin, or enter your deployed HTTPS backend URL (e.g. https://ethiop2p-api.onrender.com).
            </p>
            <input
              type="url"
              value={serverUrlInput}
              onChange={(e) => setServerUrlInput(e.target.value)}
              placeholder="https://your-backend.onrender.com"
              className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowServerModal(false)}
                className="px-3 py-1.5 text-xs font-semibold text-slate-600"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 bg-slate-900 text-white text-xs font-semibold rounded-lg"
              >
                Save URL
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Bottom 5-Tab Navigation */}
      <nav className="fixed bottom-0 inset-x-0 z-40 bg-white border-t border-slate-200">
        <div className="max-w-3xl mx-auto grid grid-cols-5">
          {[
            { id: 'home', label: lang === 'am' ? 'መነሻ' : 'Home', icon: ShieldCheck },
            { id: 'p2p', label: lang === 'am' ? 'P2P ገበያ' : 'P2P', icon: ArrowDownUp },
            { id: 'wallets', label: lang === 'am' ? 'ቦርሳ' : 'Wallets', icon: Wallet },
            { id: 'orders', label: lang === 'am' ? 'ትዕዛዝ' : 'Orders', icon: CheckCircle2 },
            { id: 'profile', label: lang === 'am' ? 'መገለጫ' : 'Profile', icon: User },
          ].map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                data-testid={`nav-${item.id}`}
                onClick={() => setTab(item.id as TabId)}
                className={`py-2.5 flex flex-col items-center justify-center gap-0.5 text-[11px] font-semibold ${
                  active ? 'text-slate-900' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                <Icon className={`w-4 h-4 ${active ? 'text-emerald-600' : ''}`} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
