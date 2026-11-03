"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Sparkline } from "@/components/charts";
import { AnomalyBadge, ErrorChip, GrowthBadge } from "@/components/ui";
import { formatNumber } from "@/lib/format";
import type { HistoryPeriod, SiteConfig, SiteHistory, SiteRealtime } from "@/lib/types";

export interface DashboardRow {
  site: SiteConfig;
  realtime?: SiteRealtime;
  history?: SiteHistory;
}

export type SortKey =
  | "activeUsers"
  | "realtimePv"
  | "today.users"
  | "today.pageviews"
  | "yesterday.users"
  | "yesterday.pageviews"
  | "last7.users"
  | "last7.pageviews"
  | "last30.users"
  | "last30.pageviews"
  | "growth";

const SORT_LABELS: Record<SortKey, string> = {
  activeUsers: "实时活跃",
  realtimePv: "30min PV",
  "today.users": "今日 UV",
  "today.pageviews": "今日 PV",
  "yesterday.users": "昨日 UV",
  "yesterday.pageviews": "昨日 PV",
  "last7.users": "7天 UV",
  "last7.pageviews": "7天 PV",
  "last30.users": "30天 UV",
  "last30.pageviews": "30天 PV",
  growth: "今日增长",
};

function metricOf(row: DashboardRow, key: SortKey): number | null {
  const [, path] = key.includes(".") ? [key.split(".")[0], key.split(".")[1]] : [key, ""];
  if (key === "activeUsers") return row.realtime && !row.realtime.error ? row.realtime.activeUsers : -1;
  if (key === "realtimePv") return row.realtime && !row.realtime.error ? row.realtime.pageviews : -1;
  if (key === "growth") {
    const pct = row.history && !row.history.error ? row.history.today.pageviewsChangePct : null;
    return pct == null ? -Infinity : pct;
  }
  if (!row.history || row.history.error) return -1;
  const period = row.history[path as "today" | "yesterday" | "last7" | "last30"];
  if (!period) return -1;
  return path.endsWith("users") ? period.users : period.pageviews;
}

function PeriodCell({ period, metric }: { period: HistoryPeriod | undefined; metric: "users" | "pageviews" }) {
  if (!period) return <span className="text-slate-300 dark:text-zinc-600">…</span>;
  return (
    <div className="flex flex-col items-start gap-1">
      <span className="tnum text-sm font-medium">{formatNumber(period[metric])}</span>
      <GrowthBadge pct={metric === "users" ? period.usersChangePct : period.pageviewsChangePct} />
    </div>
  );
}

function RealtimeCell({ realtime }: { realtime: SiteRealtime | undefined }) {
  if (!realtime) return <span className="text-slate-300 dark:text-zinc-600">…</span>;
  if (realtime.error) return <ErrorChip error={realtime.error} />;
  return (
    <div className="flex items-baseline gap-1">
      <span className="tnum text-sm font-semibold text-indigo-600 dark:text-indigo-400">
        {formatNumber(realtime.activeUsers)}
      </span>
      {realtime.activeUsers > 0 && (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
      )}
    </div>
  );
}

/** 主表格：全部站点的实时与历史数据，支持排序与异常/错误标记 */
export function SiteTable({ rows, loading }: { rows: DashboardRow[]; loading: boolean }) {
  const [sortKey, setSortKey] = useState<SortKey>("activeUsers");
  const [sortDesc, setSortDesc] = useState(true);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = metricOf(a, sortKey);
      const bv = metricOf(b, sortKey);
      const diff = (av ?? -1) - (bv ?? -1);
      return sortDesc ? -diff : diff;
    });
    return copy;
  }, [rows, sortKey, sortDesc]);

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  };

  const th = (key: SortKey, label: string, extra = "") => (
    <th
      className={`whitespace-nowrap px-3 py-2.5 text-left text-xs font-medium ${extra}`}
      aria-sort={sortKey === key ? (sortDesc ? "descending" : "ascending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(key)}
        className={`inline-flex items-center gap-1 rounded hover:text-indigo-600 dark:hover:text-indigo-400 ${
          sortKey === key ? "text-indigo-600 dark:text-indigo-400" : ""
        }`}
      >
        {label}
        <span className="text-[10px]">{sortKey === key ? (sortDesc ? "▼" : "▲") : ""}</span>
      </button>
    </th>
  );

  return (
    <div className="scroll-x rounded-xl border border-slate-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <table className="w-full min-w-[1080px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-slate-500 dark:border-zinc-800 dark:text-zinc-400">
            <th className="sticky left-0 z-10 whitespace-nowrap bg-white px-3 py-2.5 text-left text-xs font-medium dark:bg-zinc-900">
              站点
            </th>
            {th("activeUsers", SORT_LABELS.activeUsers)}
            {th("realtimePv", SORT_LABELS.realtimePv)}
            <th className="px-3 py-2.5 text-left text-xs font-medium">分钟趋势</th>
            {th("today.users", SORT_LABELS["today.users"])}
            {th("today.pageviews", SORT_LABELS["today.pageviews"])}
            {th("growth", SORT_LABELS.growth, "hidden xl:table-cell")}
            {th("yesterday.users", SORT_LABELS["yesterday.users"], "hidden xl:table-cell")}
            {th("yesterday.pageviews", SORT_LABELS["yesterday.pageviews"], "hidden xl:table-cell")}
            {th("last7.users", SORT_LABELS["last7.users"], "hidden xl:table-cell")}
            {th("last7.pageviews", SORT_LABELS["last7.pageviews"], "hidden xl:table-cell")}
            {th("last30.users", SORT_LABELS["last30.users"], "hidden 2xl:table-cell")}
            {th("last30.pageviews", SORT_LABELS["last30.pageviews"], "hidden 2xl:table-cell")}
            <th className="px-3 py-2.5 text-left text-xs font-medium">状态</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const historyError = row.history?.error && !row.realtime?.error ? row.history.error : undefined;
            return (
              <tr
                key={row.site.id}
                onClick={() => (window.location.href = `/sites/${row.site.id}`)}
                className="group cursor-pointer border-b border-slate-50 last:border-0 hover:bg-indigo-50/40 dark:border-zinc-800/60 dark:hover:bg-indigo-950/20"
              >
                <td className="sticky left-0 z-10 bg-white px-3 py-2.5 group-hover:bg-indigo-50/40 dark:bg-zinc-900 dark:group-hover:bg-indigo-950/20">
                  <Link
                    href={`/sites/${row.site.id}`}
                    onClick={(e) => e.stopPropagation()}
                    className="font-medium text-slate-900 hover:text-indigo-600 dark:text-zinc-100 dark:hover:text-indigo-400"
                  >
                    {row.site.name}
                  </Link>
                  <div className="text-xs text-slate-400 dark:text-zinc-500">{row.site.url.replace(/^https?:\/\//, "")}</div>
                </td>
                <td className="px-3 py-2.5">
                  <RealtimeCell realtime={row.realtime} />
                </td>
                <td className="px-3 py-2.5 tnum text-sm">
                  {row.realtime ? (row.realtime.error ? "—" : formatNumber(row.realtime.pageviews)) : "…"}
                </td>
                <td className="px-3 py-2.5">
                  <Sparkline values={row.realtime?.trend.map((p) => p.activeUsers) ?? []} />
                </td>
                <td className="px-3 py-2.5">
                  <PeriodCell period={row.history?.today} metric="users" />
                </td>
                <td className="px-3 py-2.5">
                  <PeriodCell period={row.history?.today} metric="pageviews" />
                </td>
                <td className="hidden px-3 py-2.5 xl:table-cell">
                  {row.history && !row.history.error ? (
                    <GrowthBadge pct={row.history.today.pageviewsChangePct} />
                  ) : (
                    <span className="text-xs text-slate-300 dark:text-zinc-600">—</span>
                  )}
                </td>
                <td className="hidden px-3 py-2.5 xl:table-cell">
                  <PeriodCell period={row.history?.yesterday} metric="users" />
                </td>
                <td className="hidden px-3 py-2.5 xl:table-cell">
                  <PeriodCell period={row.history?.yesterday} metric="pageviews" />
                </td>
                <td className="hidden px-3 py-2.5 xl:table-cell">
                  <PeriodCell period={row.history?.last7} metric="users" />
                </td>
                <td className="hidden px-3 py-2.5 xl:table-cell">
                  <PeriodCell period={row.history?.last7} metric="pageviews" />
                </td>
                <td className="hidden px-3 py-2.5 2xl:table-cell">
                  <PeriodCell period={row.history?.last30} metric="users" />
                </td>
                <td className="hidden px-3 py-2.5 2xl:table-cell">
                  <PeriodCell period={row.history?.last30} metric="pageviews" />
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-col items-start gap-1">
                    {row.history?.anomaly && !row.history.error && <AnomalyBadge anomaly={row.history.anomaly} />}
                    {historyError && <ErrorChip error={historyError} />}
                    {!row.history && !loading && (
                      <span className="text-xs text-slate-400 dark:text-zinc-500">加载中…</span>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={13} className="px-4 py-10 text-center text-sm text-slate-400 dark:text-zinc-500">
                还没有站点。前往「站点管理」添加第一个站点。
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
