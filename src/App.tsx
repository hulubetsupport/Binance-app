import { useCallback, useEffect, useState } from 'react';
import { apiFetch, getInitialApiBase, getSavedDevTgId, getTelegramWebApp } from './api';
import { AdminDashboard } from './components/AdminDashboard';
import { MiniApp } from './components/MiniApp';

export default function App() {
  const [route, setRoute] = useState<'miniapp' | 'admin'>(() =>
    window.location.pathname.startsWith('/admin') ? 'admin' : 'miniapp'
  );
  const [initData, setInitData] = useState<string>('');
  const [isTelegramEnv, setIsTelegramEnv] = useState<boolean>(false);
  const [devPreviewEnabled, setDevPreviewEnabled] = useState<boolean>(false);
  const [bootError, setBootError] = useState<string>('');

  const mintDevSession = useCallback(async (telegramId: string) => {
    const apiBase = getInitialApiBase();
    const res = await apiFetch<{ initData: string }>('/api/dev/mint-init-data', {
      apiBase,
      method: 'POST',
      body: { telegramId },
    });
    setInitData(res.initData);
  }, []);

  useEffect(() => {
    const onPopState = () => {
      setRoute(window.location.pathname.startsWith('/admin') ? 'admin' : 'miniapp');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    let active = true;
    async function boot() {
      const tg = getTelegramWebApp();
      if (tg && typeof tg.ready === 'function') {
        tg.ready();
        if (typeof tg.expand === 'function') tg.expand();
      }

      const rawTgInit = tg?.initData || '';
      if (rawTgInit) {
        if (!active) return;
        setIsTelegramEnv(true);
        setInitData(rawTgInit);
      }

      try {
        const cfg = await apiFetch('/api/config', { apiBase: getInitialApiBase() });
        if (!active) return;
        setDevPreviewEnabled(Boolean(cfg.devPreviewEnabled));

        if (!rawTgInit && cfg.devPreviewEnabled && !window.location.pathname.startsWith('/admin')) {
          await mintDevSession(getSavedDevTgId());
        }
      } catch (e: any) {
        if (active) setBootError(e?.message || 'Unable to connect to marketplace API');
      }
    }
    boot();
    return () => {
      active = false;
    };
  }, [mintDevSession]);

  const navigateTo = (target: 'miniapp' | 'admin') => {
    const nextPath = target === 'admin' ? '/admin' : '/';
    window.history.pushState({}, '', nextPath);
    setRoute(target);
  };

  if (route === 'admin') {
    return (
      <AdminDashboard
        initData={initData}
        devPreviewEnabled={devPreviewEnabled}
        onBackToMiniApp={() => navigateTo('miniapp')}
      />
    );
  }

  return (
    <>
      {bootError && (
        <div className="bg-rose-50 border-b border-rose-200 px-4 py-2 text-xs text-rose-800 text-center">
          {bootError}
        </div>
      )}
      <MiniApp
        initData={initData}
        isTelegramEnv={isTelegramEnv}
        onChangeDevUser={mintDevSession}
        onOpenAdmin={() => navigateTo('admin')}
      />
    </>
  );
}
