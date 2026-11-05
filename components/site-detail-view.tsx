"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { HistoryTrendChart } from "@/components/charts";
import { Card, ErrorChip, RangeTabs, StateHint, StatCard } from "@/components/ui";
import { getJson } from "@/lib/client";
import { formatHour, formatNumber, formatDateShort, formatTime } from "@/lib/format";
import type {
  BreakdownRow,
  HistoryResponse,
  RangeKey,
  RealtimeResponse,
  SiteConfig,
  SiteDetail,
} from "@/lib/types";

const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: "today", label: "今日" },
  { value: "yesterday", label: "昨日" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
];

function BreakdownTable({
  title,
  rows,
  emptyHint,
}: {
  title: string;
  rows: BreakdownRow[];
  emptyHint: string;
}) {
  const maxPv = Math.max(...rows.map((r) => r.pageviews), 1);
  return (
    <Card title={title}>
      {rows.length === 0 ? (
        <div className="py-4 text-center text-sm text-slate-400 dark:text-zinc-500">{emptyHint}</div>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.key}|${row.label ?? ""}`} className="border-b border-slate-50 last:border-0 dark:border-zinc-800/60">
                <td className="py-1.5 pr-3 align-top">
                  <div className="font-medium text-slate-700 dark:text-zinc-200">{row.key}</div>
                  {row.label && <div className="text-xs text-slate-400 dark:text-zinc-500">{row.label}</div>}
                </td>
                <td className="w-32 py-1.5 pl-3 align-top">
                  <div className="tnum text-xs text-slate-500 dark:text-zinc-400">
                    UV {formatNumber(row.users)} · PV {formatNumber(row.pageviews)}
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-slate-100 dark:bg-zinc-800">
                    <div
                      className="h-full rounded-full bg-indigo-400"
                      style={{ width: `${Math.max((row.pageviews / maxPv) * 100, 2)}%` }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/** 站点详情页视图：实时小卡 + 范围趋势 + 国家/设备/页面/来源 */
export function SiteDetailView({ siteId }: { siteId: string }) {
  const [site, setSite] = useState<SiteConfig | null>(null);
  const [detail, setDetail] = useState<SiteDetail | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [realtime, setRealtime] = useState<RealtimeResponse | null>(null);
  const [range, setRange] = useState<RangeKey>("7d");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    void (async () => {
      const sites = await getJson<{ sites: SiteConfig[] }>("/api/sites").catch(() => null);
      if (sites) {
        const found = sites.sites.find((s) => s.id === siteId) ?? null;
        setSite(found);
        if (!found) setNotFound(true);
      }
      const [rt, hist] = await Promise.all([
        getJson<RealtimeResponse>("/api/realtime").catch(() => null),
        getJson<HistoryResponse>("/api/history").catch(() => null),
      ]);
      if (rt) setRealtime(rt);
      if (hist) setHistory(hist);
    })();
  }, [siteId]);

  const loadDetail = useCallback(
    async (targetRange: RangeKey, force: boolean) => {
      try {
        const data = await getJson<SiteDetail>(`/api/sites/${siteId}/detail`, {
          range: targetRange,
          refresh: force ? "1" : undefined,
        });
        setDetail(data);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [siteId],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void loadDetail(range, false).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [range, loadDetail]);

  const trendData = useMemo(() => {
    if (!detail || detail.error) return [];
    if (range === "today" || range === "yesterday") {
      // 单日范围：复用 /api/history 的逐小时数据画曲线
      const siteHistory = history?.sites.find((s) => s.siteId === siteId);
      if (siteHistory && !siteHistory.error) {
        // daily 末位是今天，倒数第二位是昨天
        const targetDate = range === "today" ? siteHistory.daily.at(-1)?.date : siteHistory.daily.at(-2)?.date;
        return siteHistory.hourly
          .filter((p) => p.date === targetDate)
          .map((p) => ({ label: formatHour(p.hour), users: p.users, pageviews: p.pageviews }));
      }
      return detail.daily.map((p) => ({
        label: formatDateShort(p.date),
        users: p.users,
        pageviews: p.pageviews,
      }));
    }
    return detail.daily.map((p) => ({
      label: formatDateShort(p.date),
      users: p.users,
      pageviews: p.pageviews,
    }));
  }, [detail, range, history, siteId]);

  const siteRealtime = realtime?.sites.find((s) => s.siteId === siteId);

  if (notFound) {
    return (
      <div className="py-16 text-center">
        <p className="text-slate-500 dark:text-zinc-400">站点不存在或已被删除。</p>
        <a href="/" className="mt-3 inline-block text-sm text-indigo-600 hover:underline dark:text-indigo-400">
          返回概览
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <div className="flex items-center gap-2">
            <a href="/" className="text-sm text-slate-400 hover:text-indigo-600 dark:text-zinc-500 dark:hover:text-indigo-400">
              概览
            </a>
            <span className="text-slate-300 dark:text-zinc-600">/</span>
            <h1 className="text-xl font-semibold tracking-tight">{site?.name ?? siteId}</h1>
          </div>
          {site && (
            <p className="mt-0.5 text-xs text-slate-400 dark:text-zinc-500">
              {site.url} · Property {site.propertyId}
              {site.note ? ` · ${site.note}` : ""}
            </p>
          )}
        </div>
        <div className="ml-auto flex items-center gap-3">
          {detail && !detail.error && (
            <span className="text-xs text-slate-400 dark:text-zinc-500">更新于 {formatTime(detail.fetchedAt)}</span>
          )}
          <button
            type="button"
            onClick={() => {
              setRefreshing(true);
              void loadDetail(range, true).finally(() => setRefreshing(false));
            }}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <span className={refreshing ? "inline-block animate-spin" : "inline-block"}>⟳</span>
            刷新
          </button>
        </div>
      </div>

      {/* 实时小卡 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="实时活跃（30 分钟）"
          value={siteRealtime ? (siteRealtime.error ? "—" : formatNumber(siteRealtime.activeUsers)) : "…"}
          hint={siteRealtime?.error ? siteRealtime.error.message : undefined}
          accent
        />
        <StatCard
          label="30 分钟 PV"
          value={siteRealtime ? (siteRealtime.error ? "—" : formatNumber(siteRealtime.pageviews)) : "…"}
          hint={siteRealtime?.error ? " " : undefined}
        />
        <StatCard
          label={`${RANGE_OPTIONS.find((o) => o.value === range)?.label ?? ""} UV`}
          value={detail && !detail.error ? formatNumber(detail.totals.users) : "…"}
        />
        <StatCard
          label={`${RANGE_OPTIONS.find((o) => o.value === range)?.label ?? ""} PV`}
          value={detail && !detail.error ? formatNumber(detail.totals.pageviews) : "…"}
          hint={detail && !detail.error ? `Sessions ${formatNumber(detail.totals.sessions)}` : undefined}
        />
      </div>

      <div className="flex items-center justify-between">
        <RangeTabs value={range} onChange={setRange} options={RANGE_OPTIONS} />
        {detail?.error && <ErrorChip error={detail.error} />}
      </div>

      <StateHint loading={loading && !detail} error={error} />

      <Card title={`流量趋势 · ${RANGE_OPTIONS.find((o) => o.value === range)?.label ?? ""}`}>
        {detail?.error ? (
          <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600 dark:bg-rose-950/50 dark:text-rose-400">
            {detail.error.message}
          </div>
        ) : (
          <HistoryTrendChart data={trendData} />
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <BreakdownTable
          title="国家/地区"
          rows={detail?.countries ?? []}
          emptyHint={detail && !detail.error ? "暂无数据" : "—"}
        />
        <BreakdownTable
          title="设备类型"
          rows={detail?.devices ?? []}
          emptyHint={detail && !detail.error ? "暂无数据" : "—"}
        />
        <BreakdownTable
          title="热门页面"
          rows={detail?.pages ?? []}
          emptyHint={detail && !detail.error ? "暂无数据" : "—"}
        />
        <BreakdownTable
          title="流量来源（渠道 · 来源/媒介）"
          rows={detail?.sources ?? []}
          emptyHint={detail && !detail.error ? "暂无数据" : "—"}
        />
      </div>
    </div>
  );
}
