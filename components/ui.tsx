"use client";

import type { ReactNode } from "react";
import { formatPct } from "@/lib/format";
import type { Anomaly, ApiError } from "@/lib/types";

/** 卡片容器 */
export function Card({
  children,
  className = "",
  title,
  actions,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section
      className={`rounded-xl border border-slate-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900 ${className}`}
    >
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-zinc-200">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

/** 顶部指标卡 */
export function StatCard({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 shadow-sm ${
        accent
          ? "border-indigo-200 bg-indigo-50 dark:border-indigo-900/60 dark:bg-indigo-950/40"
          : "border-slate-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
      }`}
    >
      <div className="text-xs font-medium text-slate-500 dark:text-zinc-400">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tracking-tight tnum">{value}</div>
      {hint != null && <div className="mt-1 text-xs text-slate-400 dark:text-zinc-500">{hint}</div>}
    </div>
  );
}

/** 环比变化徽标 */
export function GrowthBadge({ pct }: { pct: number | null | undefined }) {
  if (pct == null || !Number.isFinite(pct)) {
    return <span className="text-xs text-slate-300 dark:text-zinc-600">—</span>;
  }
  const up = pct > 0;
  const flat = pct === 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-xs font-medium tnum ${
        flat
          ? "bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-400"
          : up
            ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400"
            : "bg-rose-50 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400"
      }`}
    >
      {up ? "▲" : flat ? "—" : "▼"}
      {formatPct(Math.abs(pct)).replace("+", "")}
    </span>
  );
}

const BASIS_LABELS: Record<Anomaly["basis"], string> = {
  today_same_time: "较昨日同期",
  last7: "较前 7 天",
  last30: "较前 30 天",
};

/** 异常标记 */
export function AnomalyBadge({ anomaly }: { anomaly: Anomaly }) {
  const up = anomaly.direction === "up";
  return (
    <span
      title={`流量${up ? "明显上涨" : "明显下跌"}（${BASIS_LABELS[anomaly.basis]} ${formatPct(anomaly.changePct)}）`}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium ${
        up
          ? "bg-amber-100 text-amber-700 dark:bg-amber-950/70 dark:text-amber-400"
          : "bg-sky-100 text-sky-700 dark:bg-sky-950/70 dark:text-sky-400"
      }`}
    >
      {up ? "🔺" : "🔻"}
      {BASIS_LABELS[anomaly.basis]} {formatPct(anomaly.changePct)}
    </span>
  );
}

/** 站点错误提示（悬停显示详情） */
export function ErrorChip({ error }: { error: ApiError }) {
  return (
    <span
      title={`${error.code}: ${error.message}`}
      className="inline-flex max-w-44 cursor-help items-center gap-1 truncate rounded-md bg-rose-50 px-1.5 py-0.5 text-xs text-rose-600 dark:bg-rose-950/60 dark:text-rose-400"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-rose-500" />
      <span className="truncate">{error.message}</span>
    </span>
  );
}

/** 范围切换 Tabs */
export function RangeTabs<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
            value === opt.value
              ? "bg-white text-slate-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100"
              : "text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** 加载/错误占位 */
export function StateHint({ loading, error, empty }: { loading: boolean; error?: string | null; empty?: ReactNode }) {
  if (loading) {
    return (
      <div className="animate-pulse space-y-2">
        <div className="h-4 w-2/3 rounded bg-slate-100 dark:bg-zinc-800" />
        <div className="h-4 w-1/2 rounded bg-slate-100 dark:bg-zinc-800" />
        <div className="h-4 w-3/5 rounded bg-slate-100 dark:bg-zinc-800" />
      </div>
    );
  }
  if (error) {
    return <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600 dark:bg-rose-950/50 dark:text-rose-400">{error}</div>;
  }
  if (empty) return <div className="py-6 text-center text-sm text-slate-400 dark:text-zinc-500">{empty}</div>;
  return null;
}
