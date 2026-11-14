import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, FileCheck2, Gavel, Landmark, RefreshCw, Settings, ShieldCheck, Users } from 'lucide-react';
import {
  apiFetch,
  fileToDataUrl,
  getHashAdminToken,
  getSavedAdminKey,
  setSavedAdminKey,
} from '../api';
import { PrivateImage } from './PrivateImage';

interface AdminDashboardProps {
  initData: string;
  devPreviewEnabled: boolean;
  onBackToMiniApp?: () => void;
}

type AdminSection = 'kyc' | 'orders' | 'deposits' | 'disputes' | 'users' | 'settings';

export function AdminDashboard({ initData, devPreviewEnabled, onBackToMiniApp }: AdminDashboardProps) {
  const [adminToken, setAdminToken] = useState<string>(() => getHashAdminToken());
  const [adminKey, setAdminKey] = useState<string>(() => getSavedAdminKey());
  const [keyInput, setKeyInput] = useState<string>(() => getSavedAdminKey());
  const [useInitDataAuth, setUseInitDataAuth] = useState<boolean>(Boolean(initData));

  const [section, setSection] = useState<AdminSection>('kyc');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [overview, setOverview] = useState<any>(null);
  const [kycList, setKycList] = useState<any[]>([]);
  const [kycFilter, setKycFilter] = useState<string>('PENDING');
  const [rejectReasons, setRejectReasons] = useState<Record<number, string>>({});

  const [orders, setOrders] = useState<any[]>([]);
  const [orderFilter, setOrderFilter] = useState<string>('ALL');
  const [payoutRefs, setPayoutRefs] = useState<Record<number, string>>({});
  const [payoutFiles, setPayoutFiles] = useState<Record<number, File | null>>({});

  const [deposits, setDeposits] = useState<any[]>([]);
  const [txHashInputs, setTxHashInputs] = useState<Record<number, string>>({});

  const [disputes, setDisputes] = useState<any[]>([]);
  const [disputeNotes, setDisputeNotes] = useState<Record<number, string>>({});
  const [disputeFiles, setDisputeFiles] = useState<Record<number, File | null>>({});

  const [users, setUsers] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [commissions, setCommissions] = useState<any[]>([]);

  const [rateInput, setRateInput] = useState('');
  const [commInput, setCommInput] = useState('');
  const [dailyLimitInput, setDailyLimitInput] = useState('');
  const [maxDisputesInput, setMaxDisputesInput] = useState('');

  const [previewInitData, setPreviewInitData] = useState<string>('');

  const authOpts = useCallback(
    () => ({
      initData: previewInitData || (useInitDataAuth ? initData : undefined),
      adminToken: adminToken || undefined,
      adminKey: adminKey || undefined,
    }),
    [previewInitData, useInitDataAuth, initData, adminToken, adminKey]
  );

  const loadAll = useCallback(async () => {
    if (!authOpts().initData && !authOpts().adminToken && !authOpts().adminKey) return;
    setLoading(true);
    setError('');
    try {
      const ov = await apiFetch('/api/admin/overview', authOpts());
      setOverview(ov);
      setRateInput(ov.settings.referenceRateEtb);
      setCommInput(String(ov.settings.commissionPercent));
      setDailyLimitInput(ov.settings.dailyLimitUsdt);
      setMaxDisputesInput(String(ov.settings.maxDisputesBeforeSuspend));

      const [kycRes, ordRes, depRes, dispRes, usrRes, audRes] = await Promise.all([
        apiFetch(`/api/admin/kyc?status=${kycFilter}`, authOpts()),
        apiFetch(`/api/admin/orders?status=${orderFilter}`, authOpts()),
        apiFetch('/api/admin/deposits', authOpts()),
        apiFetch('/api/admin/disputes', authOpts()),
        apiFetch('/api/admin/users', authOpts()),
        apiFetch('/api/admin/audit-log', authOpts()),
      ]);
      setKycList(kycRes.submissions || []);
      setOrders(ordRes.orders || []);
      setDeposits(depRes.deposits || []);
      setDisputes(dispRes.disputes || []);
      setUsers(usrRes.users || []);
      setAuditLogs(audRes.auditLogs || []);
      setCommissions(audRes.commissions || []);
    } catch (e: any) {
      setError(e?.message || 'Admin authentication failed');
    } finally {
      setLoading(false);
    }
  }, [authOpts, kycFilter, orderFilter]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleLoginWithKey = (e: React.FormEvent) => {
    e.preventDefault();
    setPreviewInitData('');
    setSavedAdminKey(keyInput.trim());
    setAdminKey(keyInput.trim());
    setUseInitDataAuth(false);
  };

  const handleDevAdminLogin = async () => {
    setError('');
    setLoading(true);
    try {
      const minted = await apiFetch<{ initData: string }>('/api/dev/mint-init-data', {
        method: 'POST',
        body: { telegramId: '100001' },
      });
      setUseInitDataAuth(true);
      setPreviewInitData(minted.initData);
      setNotice('Authenticated as Preview Admin (100001)');
    } catch (e: any) {
      setError(e?.message || 'Unable to authenticate preview admin');
    } finally {
      setLoading(false);
    }
  };

  const effectiveAuth = () => authOpts();

  const handleReviewKyc = async (id: number, decision: 'APPROVED' | 'REJECTED') => {
    setError('');
    setNotice('');
    try {
      await apiFetch(`/api/admin/kyc/${id}/review`, {
        ...effectiveAuth(),
        method: 'POST',
        body: { decision, reason: rejectReasons[id] || '' },
      });
      setNotice(`KYC #${id} ${decision}`);
      await loadAll();
    } catch (e: any) {
      setError(e?.message || 'Failed to review KYC');
    }
  };

  const handleConfirmPayment = async (orderId: number) => {
    setError('');
    try {
      await apiFetch(`/api/admin/orders/${orderId}/confirm-payment`, {
        ...effectiveAuth(),
        method: 'POST',
      });
      setNotice(`Payment confirmed for Order #${orderId}`);
      await loadAll();
    } catch (e: any) {
      setError(e?.message || 'Confirm failed');
    }
  };

  const handleMarkPaidOut = async (orderId: number) => {
    setError('');
    try {
      const file = payoutFiles[orderId];
      if (!file) throw new Error('Attach payout proof screenshot first');
      const payoutProofBase64 = await fileToDataUrl(file);
      await apiFetch(`/api/admin/orders/${orderId}/paid-out`, {
        ...effectiveAuth(),
        method: 'POST',
        body: {
          payoutRef: payoutRefs[orderId] || `PAYOUT_${orderId}`,
          payoutProofBase64,
        },
      });
      setNotice(`Order #${orderId} RELEASED and commission recorded`);
      await loadAll();
    } catch (e: any) {
      setError(e?.message || 'Paid out failed');
    }
  };

  const handleMatchDeposit = async (intentId: number) => {
    setError('');
    try {
      const txHash = (txHashInputs[intentId] || '').trim();
      if (!txHash) throw new Error('Enter blockchain txHash to match');
      await apiFetch('/api/admin/deposits/match', {
        ...effectiveAuth(),
        method: 'POST',
        body: { intentId, txHash },
      });
      setNotice(`Deposit #${intentId} matched and credited`);
      await loadAll();
    } catch (e: any) {
      setError(e?.message || 'Deposit match failed');
    }
  };

  const handleResolveDispute = async (disputeId: number, resolution: 'RESOLVED_RELEASE' | 'RESOLVED_REFUND') => {
    setError('');
    try {
      let payoutProofBase64: string | undefined;
      if (resolution === 'RESOLVED_RELEASE') {
        const file = disputeFiles[disputeId];
        if (!file) throw new Error('Payout proof screenshot required to release');
        payoutProofBase64 = await fileToDataUrl(file);
      }
      await apiFetch(`/api/admin/disputes/${disputeId}/resolve`, {
        ...effectiveAuth(),
        method: 'POST',
        body: {
          resolution,
          note: disputeNotes[disputeId] || `Resolved via Admin Console (${resolution})`,
          payoutProofBase64,
        },
      });
      setNotice(`Dispute #${disputeId} resolved (${resolution})`);
      await loadAll();
    } catch (e: any) {
      setError(e?.message || 'Resolve dispute failed');
    }
  };

  const handleUnsuspend = async (userId: number) => {
    setError('');
    try {
      await apiFetch(`/api/admin/users/${userId}/unsuspend`, {
        ...effectiveAuth(),
        method: 'POST',
      });
      setNotice(`User #${userId} unsuspended`);
      await loadAll();
    } catch (e: any) {
      setError(e?.message || 'Failed to unsuspend');
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await apiFetch('/api/admin/settings', {
        ...effectiveAuth(),
        method: 'POST',
        body: {
          referenceRateEtb: rateInput,
          commissionPercent: Number(commInput),
          dailyLimitUsdt: dailyLimitInput,
          maxDisputesBeforeSuspend: Number(maxDisputesInput),
        },
      });
      setNotice('Marketplace settings updated');
      await loadAll();
    } catch (e: any) {
      setError(e?.message || 'Failed to save settings');
    }
  };

  const isAuthed = Boolean(overview);

  if (!isAuthed) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-bold text-slate-900">EthioP2P Admin Console</h1>
            {onBackToMiniApp && (
              <button
                type="button"
                onClick={onBackToMiniApp}
                className="text-xs font-medium text-slate-600 hover:text-slate-900 flex items-center gap-1"
              >
                <ArrowLeft className="w-3.5 h-3.5" /> Mini App
              </button>
            )}
          </div>
          <p className="text-sm text-slate-600">
            Authenticate via Telegram WebApp (`ADMIN_IDS`), `/admin` bot token link, or Admin API Key.
          </p>
          {error && <div className="p-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg">{error}</div>}
          <form onSubmit={handleLoginWithKey} className="space-y-3">
            <div>
              <label htmlFor="admin-key-input" className="block text-xs font-semibold text-slate-700 mb-1">
                Admin API Key
              </label>
              <input
                id="admin-key-input"
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder="Enter ADMIN_API_KEY"
                className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-amber-600"
              />
            </div>
            <button
              type="submit"
              className="w-full py-2.5 px-4 bg-slate-900 text-white text-sm font-semibold rounded-lg hover:bg-slate-800 transition-colors"
            >
              Sign In to Admin Console
            </button>
          </form>
          {devPreviewEnabled && (
            <button
              type="button"
              onClick={handleDevAdminLogin}
              className="w-full py-2 px-4 bg-amber-50 text-amber-900 border border-amber-200 text-xs font-semibold rounded-lg hover:bg-amber-100"
            >
              Use Dev Preview Admin (100001)
            </button>
          )}
        </div>
      </div>
    );
  }

  const navItems: Array<{ id: AdminSection; label: string; icon: any; count?: number }> = [
    { id: 'kyc', label: 'KYC Queue', icon: ShieldCheck, count: overview?.kpis?.pendingKyc },
    { id: 'orders', label: 'Orders & Payouts', icon: FileCheck2, count: overview?.kpis?.pendingPayouts },
    { id: 'deposits', label: 'Deposit Matching', icon: Landmark, count: overview?.kpis?.pendingDeposits },
    { id: 'disputes', label: 'Disputes', icon: Gavel, count: overview?.kpis?.openDisputes },
    { id: 'users', label: 'Users', icon: Users },
    { id: 'settings', label: 'Settings & Audit', icon: Settings },
  ];

  const activeAuth = effectiveAuth();

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col md:flex-row">
      {/* Sidebar */}
      <aside className="w-full md:w-64 bg-white border-b md:border-b-0 md:border-r border-slate-200 p-4 flex flex-col justify-between shrink-0">
        <div>
          <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-200">
            <span className="text-base font-bold text-slate-900 tracking-tight whitespace-nowrap">
              EthioP2P Admin
            </span>
            {onBackToMiniApp && (
              <button
                type="button"
                onClick={onBackToMiniApp}
                className="text-xs font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap"
              >
                Mini App
              </button>
            )}
          </div>
          <nav className="flex md:flex-col gap-1 overflow-x-auto pb-1 md:pb-0">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = section === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSection(item.id)}
                  className={`flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                    active ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </span>
                  {typeof item.count === 'number' && item.count > 0 && (
                    <span className={`font-mono text-xs ${active ? 'text-amber-300' : 'text-amber-700'}`}>
                      {item.count}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="hidden md:block pt-4 border-t border-slate-200 text-xs text-slate-500">
          <div>Admin Actor · {overview.adminActorId}</div>
          <button
            type="button"
            onClick={() => {
              setSavedAdminKey('');
              setAdminKey('');
              setAdminToken('');
              setOverview(null);
            }}
            className="mt-2 text-rose-700 hover:underline font-medium"
          >
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 p-4 md:p-6 max-w-6xl">
        {/* Top bar & KPI strip */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
          <div>
            <h1 className="text-xl font-bold text-slate-900">Marketplace Operations</h1>
            <p className="text-xs text-slate-500">
              Ref Rate: {overview.settings.referenceRateEtb} ETB/USDT · Commission: {overview.settings.commissionPercent}% · Daily Limit: {overview.settings.dailyLimitUsdt} USDT
            </p>
          </div>
          <button
            type="button"
            onClick={loadAll}
            disabled={loading}
            className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-slate-700 hover:bg-slate-50 flex items-center gap-1.5 whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>

        {/* KPI Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
          <div className="bg-white border border-slate-200 rounded-xl p-3.5">
            <div className="text-xs text-slate-500">Pending KYC</div>
            <div className="text-xl font-bold font-mono tabular-nums text-slate-900 mt-1">{overview.kpis.pendingKyc}</div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-3.5">
            <div className="text-xs text-slate-500">Pending Payouts</div>
            <div className="text-xl font-bold font-mono tabular-nums text-amber-700 mt-1">{overview.kpis.pendingPayouts}</div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-3.5">
            <div className="text-xs text-slate-500">Pending Deposits</div>
            <div className="text-xl font-bold font-mono tabular-nums text-slate-900 mt-1">{overview.kpis.pendingDeposits}</div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-3.5">
            <div className="text-xs text-slate-500">Open Disputes</div>
            <div className="text-xl font-bold font-mono tabular-nums text-rose-700 mt-1">{overview.kpis.openDisputes}</div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-3.5 col-span-2 lg:col-span-1">
            <div className="text-xs text-slate-500">Commissions Earned</div>
            <div className="text-xl font-bold font-mono tabular-nums text-emerald-700 mt-1">
              {overview.kpis.totalCommissionUsdt} USDT
            </div>
          </div>
        </div>

        {error && <div className="mb-4 p-3 text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-lg">{error}</div>}
        {notice && (
          <div className="mb-4 p-3 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" /> {notice}
          </div>
        )}

        {/* Section 1: KYC */}
        {section === 'kyc' && (
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-slate-900">KYC Verification Queue</h2>
              <div className="flex gap-1 bg-slate-200/70 p-1 rounded-lg">
                {['PENDING', 'APPROVED', 'REJECTED', 'ALL'].map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setKycFilter(st)}
                    className={`px-2.5 py-1 text-xs font-semibold rounded-md ${
                      kycFilter === st ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                    }`}
                  >
                    {st}
                  </button>
                ))}
              </div>
            </div>

            {kycList.length === 0 ? (
              <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
                No KYC submissions matching filter {kycFilter}.
              </div>
            ) : (
              <div className="space-y-4">
                {kycList.map((k) => (
                  <div key={k.id} className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="font-bold text-slate-900">{k.full_name}</div>
                        <div className="text-xs text-slate-500 font-mono">
                          KYC #{k.id} · ID: {k.national_id_number} · Phone: {k.phone_number} · TG: {k.telegram_id}
                        </div>
                      </div>
                      <span
                        className={`text-xs font-bold ${
                          k.status === 'APPROVED'
                            ? 'text-emerald-700'
                            : k.status === 'REJECTED'
                            ? 'text-rose-700'
                            : 'text-amber-700'
                        }`}
                      >
                        {k.status}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <div className="text-xs font-medium text-slate-600 mb-1">ID Front (Private)</div>
                        <PrivateImage fileId={k.id_front_file_id} alt="ID Front" {...activeAuth} className="w-full h-40" />
                      </div>
                      <div>
                        <div className="text-xs font-medium text-slate-600 mb-1">Selfie Holding ID (Private)</div>
                        <PrivateImage fileId={k.selfie_file_id} alt="Selfie" {...activeAuth} className="w-full h-40" />
                      </div>
                    </div>

                    {k.status === 'PENDING' && (
                      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100">
                        <button
                          type="button"
                          onClick={() => handleReviewKyc(k.id, 'APPROVED')}
                          className="px-4 py-2 bg-emerald-600 text-white text-xs font-semibold rounded-lg hover:bg-emerald-700"
                        >
                          Approve KYC
                        </button>
                        <input
                          type="text"
                          value={rejectReasons[k.id] || ''}
                          onChange={(e) => setRejectReasons({ ...rejectReasons, [k.id]: e.target.value })}
                          placeholder="Rejection reason (required to reject)"
                          className="flex-1 min-w-[200px] px-3 py-2 text-xs border border-slate-300 rounded-lg"
                        />
                        <button
                          type="button"
                          onClick={() => handleReviewKyc(k.id, 'REJECTED')}
                          className="px-4 py-2 bg-rose-600 text-white text-xs font-semibold rounded-lg hover:bg-rose-700"
                        >
                          Reject
                        </button>
                      </div>
                    )}
                    {k.rejection_reason && (
                      <div className="text-xs text-rose-700">Rejection reason: {k.rejection_reason}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Section 2: Orders & Payouts */}
        {section === 'orders' && (
          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-bold text-slate-900">Orders & Manual Payout Queue</h2>
              <div className="flex gap-1 bg-slate-200/70 p-1 rounded-lg overflow-x-auto">
                {['ALL', 'PAID_MARKED', 'AWAITING_PAYMENT', 'RELEASED', 'DISPUTED', 'EXPIRED'].map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setOrderFilter(st)}
                    className={`px-2.5 py-1 text-xs font-semibold rounded-md whitespace-nowrap ${
                      orderFilter === st ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                    }`}
                  >
                    {st}
                  </button>
                ))}
              </div>
            </div>

            {orders.length === 0 ? (
              <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
                No orders found for status {orderFilter}.
              </div>
            ) : (
              <div className="space-y-4">
                {orders.map((o) => (
                  <div key={o.id} className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="font-mono font-bold text-slate-900">{o.orderCode}</span>
                        <span className="text-xs text-slate-500 ml-2">
                          {o.direction} · Buyer: {o.buyerName} · Seller: {o.sellerName}
                        </span>
                      </div>
                      <span className="text-xs font-bold font-mono text-slate-800">{o.status}</span>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs bg-slate-50 p-3 rounded-lg">
                      <div>
                        <div className="text-slate-500">Gross USDT</div>
                        <div className="font-mono tabular-nums font-bold">{o.grossUsdt} USDT</div>
                      </div>
                      <div>
                        <div className="text-slate-500">Fee ({o.commissionPercent}%)</div>
                        <div className="font-mono tabular-nums font-bold">{o.feeUsdt} USDT</div>
                      </div>
                      <div>
                        <div className="text-slate-500">Net Payout</div>
                        <div className="font-mono tabular-nums font-bold text-emerald-700">{o.netUsdt} USDT</div>
                      </div>
                      <div>
                        <div className="text-slate-500">ETB Total</div>
                        <div className="font-mono tabular-nums font-bold">{o.etbTotal} ETB</div>
                      </div>
                    </div>

                    <div className="text-xs text-slate-600 space-y-1">
                      <div>
                        Payout Target: <strong className="text-slate-900">{o.payoutProvider || 'Not set'}</strong>{' '}
                        <span className="font-mono">{o.payoutAccountId || '-'}</span> ({o.payoutAccountName || '-'})
                      </div>
                      <div>
                        Payment Ref: <span className="font-mono text-slate-900">{o.paymentRef || '-'}</span> · Confirmed:{' '}
                        <strong>{o.paymentConfirmedByAdmin ? 'YES' : 'NO'}</strong>
                      </div>
                    </div>

                    {(o.paymentProofFileId || o.payoutProfileFileId || o.payoutProofFileId) && (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        {o.paymentProofFileId && (
                          <div>
                            <div className="text-[11px] text-slate-500 mb-1">ETB Payment Proof</div>
                            <PrivateImage fileId={o.paymentProofFileId} alt="Payment proof" {...activeAuth} className="w-full h-32" />
                          </div>
                        )}
                        {o.payoutProfileFileId && (
                          <div>
                            <div className="text-[11px] text-slate-500 mb-1">Receiver Payout Profile</div>
                            <PrivateImage fileId={o.payoutProfileFileId} alt="Payout profile" {...activeAuth} className="w-full h-32" />
                          </div>
                        )}
                        {o.payoutProofFileId && (
                          <div>
                            <div className="text-[11px] text-slate-500 mb-1">Admin Payout Proof</div>
                            <PrivateImage fileId={o.payoutProofFileId} alt="Admin payout proof" {...activeAuth} className="w-full h-32" />
                          </div>
                        )}
                      </div>
                    )}

                    {(o.status === 'PAID_MARKED' || o.status === 'DISPUTED') && (
                      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100">
                        {!o.paymentConfirmedByAdmin && (
                          <button
                            type="button"
                            onClick={() => handleConfirmPayment(o.id)}
                            className="px-3 py-2 bg-slate-900 text-white text-xs font-semibold rounded-lg hover:bg-slate-800"
                          >
                            Confirm Payment
                          </button>
                        )}
                        <input
                          type="text"
                          value={payoutRefs[o.id] || ''}
                          onChange={(e) => setPayoutRefs({ ...payoutRefs, [o.id]: e.target.value })}
                          placeholder="Binance Pay / Bybit payout ref"
                          className="px-3 py-2 text-xs border border-slate-300 rounded-lg min-w-[180px]"
                        />
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          onChange={(e) => setPayoutFiles({ ...payoutFiles, [o.id]: e.target.files?.[0] || null })}
                          className="text-xs text-slate-600"
                        />
                        <button
                          type="button"
                          onClick={() => handleMarkPaidOut(o.id)}
                          className="px-3.5 py-2 bg-emerald-600 text-white text-xs font-semibold rounded-lg hover:bg-emerald-700"
                        >
                          Paid Out → RELEASED
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Section 3: Deposit Matching */}
        {section === 'deposits' && (
          <section className="space-y-4">
            <h2 className="text-base font-bold text-slate-900">On-Chain Deposit Matching (TRC20 & BEP20)</h2>
            <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                  <tr>
                    <th className="p-3">Intent</th>
                    <th className="p-3">User</th>
                    <th className="p-3">Network</th>
                    <th className="p-3 text-right">Unique Match Amount</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Match Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {deposits.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="p-6 text-center text-slate-500">
                        No deposit intents yet.
                      </td>
                    </tr>
                  ) : (
                    deposits.map((d) => (
                      <tr key={d.id}>
                        <td className="p-3 font-mono font-semibold">{d.intent_code}</td>
                        <td className="p-3">
                          {d.first_name} {d.last_name} <span className="text-slate-400">({d.telegram_id})</span>
                        </td>
                        <td className="p-3 font-semibold">{d.network}</td>
                        <td className="p-3 text-right font-mono tabular-nums font-bold text-slate-900">
                          {d.uniqueUsdt} USDT
                        </td>
                        <td className="p-3 font-semibold">{d.status}</td>
                        <td className="p-3">
                          {d.status === 'PENDING' ? (
                            <div className="flex items-center gap-2">
                              <input
                                type="text"
                                value={txHashInputs[d.id] || ''}
                                onChange={(e) => setTxHashInputs({ ...txHashInputs, [d.id]: e.target.value })}
                                placeholder="TxHash"
                                className="px-2.5 py-1.5 border border-slate-300 rounded-md text-xs w-40"
                              />
                              <button
                                type="button"
                                onClick={() => handleMatchDeposit(d.id)}
                                className="px-3 py-1.5 bg-emerald-600 text-white rounded-md text-xs font-semibold hover:bg-emerald-700"
                              >
                                Match & Credit
                              </button>
                            </div>
                          ) : (
                            <span className="font-mono text-slate-500">{d.tx_hash || '-'}</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Section 4: Disputes */}
        {section === 'disputes' && (
          <section className="space-y-4">
            <h2 className="text-base font-bold text-slate-900">Order Disputes</h2>
            {disputes.length === 0 ? (
              <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
                No disputes recorded.
              </div>
            ) : (
              <div className="space-y-4">
                {disputes.map((d) => (
                  <div key={d.id} className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="font-bold text-slate-900">Dispute #{d.id}</span> ·{' '}
                        <span className="font-mono">{d.order_code}</span> ({d.grossUsdt} USDT / {d.etbTotal} ETB)
                      </div>
                      <span className={`text-xs font-bold ${d.status === 'OPEN' ? 'text-rose-700' : 'text-emerald-700'}`}>
                        {d.status}
                      </span>
                    </div>
                    <div className="text-xs text-slate-600">
                      Opened by: {d.opened_by_name} ({d.opened_by_tg}) · Against: {d.against_name} ({d.against_tg})
                    </div>
                    <div className="text-xs bg-slate-50 p-3 rounded-lg text-slate-800">Reason: {d.reason}</div>
                    {d.status === 'OPEN' && (
                      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100">
                        <input
                          type="text"
                          value={disputeNotes[d.id] || ''}
                          onChange={(e) => setDisputeNotes({ ...disputeNotes, [d.id]: e.target.value })}
                          placeholder="Resolution note"
                          className="flex-1 min-w-[180px] px-3 py-2 text-xs border border-slate-300 rounded-lg"
                        />
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          onChange={(e) => setDisputeFiles({ ...disputeFiles, [d.id]: e.target.files?.[0] || null })}
                          className="text-xs text-slate-600"
                        />
                        <button
                          type="button"
                          onClick={() => handleResolveDispute(d.id, 'RESOLVED_RELEASE')}
                          className="px-3 py-2 bg-emerald-600 text-white text-xs font-semibold rounded-lg hover:bg-emerald-700"
                        >
                          Release (w/ Proof)
                        </button>
                        <button
                          type="button"
                          onClick={() => handleResolveDispute(d.id, 'RESOLVED_REFUND')}
                          className="px-3 py-2 bg-rose-600 text-white text-xs font-semibold rounded-lg hover:bg-rose-700"
                        >
                          Refund to Seller
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Section 5: Users */}
        {section === 'users' && (
          <section className="space-y-4">
            <h2 className="text-base font-bold text-slate-900">Registered Users & Risk Controls</h2>
            <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                  <tr>
                    <th className="p-3">User</th>
                    <th className="p-3">KYC</th>
                    <th className="p-3 text-right">Available</th>
                    <th className="p-3 text-right">Locked</th>
                    <th className="p-3 text-right">Dispute Losses</th>
                    <th className="p-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td className="p-3">
                        <div className="font-semibold text-slate-900">
                          {u.first_name} {u.last_name}
                        </div>
                        <div className="text-slate-500 font-mono">
                          {u.telegram_id} {u.username ? `· @${u.username}` : ''}
                        </div>
                      </td>
                      <td className="p-3 font-semibold">{u.kyc_status}</td>
                      <td className="p-3 text-right font-mono tabular-nums">{u.availableUsdt}</td>
                      <td className="p-3 text-right font-mono tabular-nums">{u.lockedUsdt}</td>
                      <td className="p-3 text-right font-mono tabular-nums">{u.dispute_losses}</td>
                      <td className="p-3">
                        {u.is_suspended ? (
                          <div className="flex items-center gap-2">
                            <span className="text-rose-700 font-bold">SUSPENDED</span>
                            <button
                              type="button"
                              onClick={() => handleUnsuspend(u.id)}
                              className="px-2 py-1 bg-slate-900 text-white rounded text-[11px]"
                            >
                              Unsuspend
                            </button>
                          </div>
                        ) : (
                          <span className="text-emerald-700 font-semibold">ACTIVE</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Section 6: Settings & Audit Log */}
        {section === 'settings' && (
          <section className="space-y-6">
            <form onSubmit={handleSaveSettings} className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <h2 className="text-base font-bold text-slate-900">Marketplace Rules & Price Guard</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Reference Rate (ETB/USDT)</label>
                  <input
                    type="text"
                    value={rateInput}
                    onChange={(e) => setRateInput(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Commission (%)</label>
                  <input
                    type="number"
                    value={commInput}
                    onChange={(e) => setCommInput(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Approved Daily Limit (USDT)</label>
                  <input
                    type="text"
                    value={dailyLimitInput}
                    onChange={(e) => setDailyLimitInput(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Disputes Auto-Suspend</label>
                  <input
                    type="number"
                    value={maxDisputesInput}
                    onChange={(e) => setMaxDisputesInput(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
              </div>
              <button
                type="submit"
                className="px-4 py-2 bg-slate-900 text-white text-xs font-semibold rounded-lg hover:bg-slate-800"
              >
                Save Settings
              </button>
            </form>

            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <h3 className="text-sm font-bold text-slate-900">Recorded Commissions (Only Released Orders)</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="p-2.5">Order</th>
                      <th className="p-2.5">Seller</th>
                      <th className="p-2.5 text-right">Gross</th>
                      <th className="p-2.5 text-right">Fee</th>
                      <th className="p-2.5">Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {commissions.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="p-4 text-center text-slate-500">
                          No commissions recorded yet.
                        </td>
                      </tr>
                    ) : (
                      commissions.map((c) => (
                        <tr key={c.id}>
                          <td className="p-2.5 font-mono font-semibold">{c.order_code}</td>
                          <td className="p-2.5">{c.seller_name}</td>
                          <td className="p-2.5 text-right font-mono tabular-nums">{c.grossUsdt} USDT</td>
                          <td className="p-2.5 text-right font-mono tabular-nums font-bold text-emerald-700">{c.feeUsdt} USDT</td>
                          <td className="p-2.5 text-slate-500">{new Date(c.created_at).toLocaleString()}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <h3 className="text-sm font-bold text-slate-900">Immutable Audit Log</h3>
              <div className="space-y-2 max-h-80 overflow-y-auto text-xs">
                {auditLogs.map((l) => (
                  <div key={l.id} className="flex flex-wrap justify-between gap-2 py-2 border-b border-slate-100">
                    <div>
                      <span className="font-mono font-semibold text-slate-900">{l.action}</span>{' '}
                      <span className="text-slate-500">
                        by {l.actor_type}:{l.actor_id} on {l.target_type}#{l.target_id}
                      </span>
                      {l.details && <div className="text-slate-500 font-mono text-[11px]">{l.details}</div>}
                    </div>
                    <span className="text-slate-400 font-mono">{new Date(l.created_at).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
