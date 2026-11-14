import { useEffect, useState } from 'react';

interface OrderCountdownProps {
  expiresAt: string;
  serverOffsetMs: number;
  status: string;
}

export function OrderCountdown({ expiresAt, serverOffsetMs, status }: OrderCountdownProps) {
  const [remainingMs, setRemainingMs] = useState<number>(() => {
    const serverNow = Date.now() + serverOffsetMs;
    return Math.max(0, new Date(expiresAt).getTime() - serverNow);
  });

  useEffect(() => {
    const tick = () => {
      const serverNow = Date.now() + serverOffsetMs;
      setRemainingMs(Math.max(0, new Date(expiresAt).getTime() - serverNow));
    };
    tick();
    if (status !== 'CREATED' && status !== 'AWAITING_PAYMENT') return;
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt, serverOffsetMs, status]);

  if (status !== 'CREATED' && status !== 'AWAITING_PAYMENT') {
    return null;
  }

  const totalSec = Math.floor(remainingMs / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  const formatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  const urgent = totalSec <= 180;

  return (
    <span
      data-testid="order-countdown"
      className={`font-mono tabular-nums text-sm font-semibold ${
        urgent ? 'text-rose-700' : 'text-amber-700'
      }`}
    >
      {totalSec === 0 ? '00:00 (Expiring)' : formatted}
    </span>
  );
}

const TIMELINE_STEPS = [
  { key: 'CREATED', labelEn: 'Created', labelAm: 'ተፈጥሯል' },
  { key: 'AWAITING_PAYMENT', labelEn: 'Awaiting Payment', labelAm: 'ክፍያ ይጠብቃል' },
  { key: 'PAID_MARKED', labelEn: 'Paid Marked', labelAm: 'ተከፍሏል' },
  { key: 'RELEASED', labelEn: 'Released', labelAm: 'ተለቋል' },
];

export function OrderStatusTimeline({ status }: { status: string }) {
  const isTerminalAlt = status === 'CANCELLED' || status === 'EXPIRED' || status === 'DISPUTED';
  const activeIdx = TIMELINE_STEPS.findIndex((s) => s.key === status);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-4 gap-2">
        {TIMELINE_STEPS.map((step, idx) => {
          const completed = !isTerminalAlt && activeIdx >= idx;
          return (
            <div key={step.key} className="flex flex-col gap-1">
              <div
                className={`h-1.5 rounded-full transition-colors ${
                  completed ? 'bg-emerald-600' : isTerminalAlt && idx === 0 ? 'bg-slate-400' : 'bg-slate-200'
                }`}
              />
              <span className={`text-[11px] font-medium leading-tight ${completed ? 'text-slate-900' : 'text-slate-500'}`}>
                {step.labelEn}
              </span>
              <span className="text-[10px] text-slate-400 leading-tight">{step.labelAm}</span>
            </div>
          );
        })}
      </div>
      {isTerminalAlt && (
        <div
          className={`text-xs font-semibold ${
            status === 'DISPUTED' ? 'text-amber-700' : 'text-rose-700'
          }`}
        >
          Final Status: {status}
        </div>
      )}
    </div>
  );
}
