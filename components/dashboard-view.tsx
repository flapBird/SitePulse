"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HistoryTrendChart, MinuteTrendChart } from "@/components/charts";
import { SiteTable, type DashboardRow } from "@/components/site-table";
import { Card, ErrorChip, RangeTabs, StatCard, StateHint } from "@/components/ui";
import { getJson } from "@/lib/client";
import { formatNumber, formatTime } from "@/lib/format";
import type {
  HealthResponse,
  HistoryResponse,
  RangeKey,
  RealtimeResponse,
  SiteConfig,
} from "@/lib/types";

const REFRESH_INTERVAL_MS = 60_000;

const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: "today", label: "今日" },
  { value: "yesterday", label: "昨日" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
];

/** RangeKey → SiteHistory 上的周期字段名 */
const PERIOD_KEY: Record<RangeKey, "today" | "yesterday" | "last7" | "last30"> = {
  today: "today",
  yesterday: "yesterday",
  "7d": "last7",
  "30d": "last30",
};

/** 首页：实时优先，其次历史统计与排名 */
export function DashboardView() {
  const [sites, setSites] = useState<SiteConfig[]>([]);
  const [realtime, setRealtime] = useState<RealtimeResponse | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [range, setRange] = useState<RangeKey>("today");
  const [rankMetric, setRankMetric] = useState<"users" | "pageviews">("pageviews");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadRealtime = useCallback(async (force: boolean) => {
    try {
      const data = await getJson<RealtimeResponse>("/api/realtime", { refresh: force ? "1" : undefined });
      setRealtime(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadHistory = useCallback(async (force: boolean) => {
    try {
      const data = await getJson<HistoryResponse>("/api/history", { refresh: force ? "1" : undefined });
      setHistory(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const initial = async () => {
      setLoading(true);
      const healthTask = getJson<HealthResponse>("/api/health").catch(() => null);
      // 站点清单从 history/realtime 的 siteId 反推不足（缺 name/url），
      // 直接从 health + manage 接口取；health 失败不阻塞
      const [healthData] = await Promise.all([healthTask]);
      const sitesData = await getJson<{ sites: SiteConfig[] }>("/api/sites").catch(() => null);
      if (!cancelled) {
        setHealth(healthData);
        if (sitesData) setSites(sitesData.sites);
      }
      await Promise.all([loadRealtime(false), loadHistory(false)]);
      if (!cancelled) setLoading(false);
    };
    void initial();
    return () => {
      cancelled = true;
    };
  }, [loadHistory, loadRealtime]);

  // 60 秒自动刷新实时数据（标签页隐藏时暂停）
  useEffect(() => {
    timerRef.current = setInterval(() => {
      if (document.visibilityState === "visible") void loadRealtime(false);
    }, REFRESH_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [loadRealtime]);

  const manualRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadRealtime(true), loadHistory(true)]);
    setRefreshing(false);
  }, [loadHistory, loadRealtime]);

  const siteById = useMemo(() => new Map(sites.map((s) => [s.id, s] as const)), [sites]);

  const rows: DashboardRow[] = useMemo(() => {
    const ids = new Set<string>([
      ...sites.map((s) => s.id),
      ...(realtime?.sites ?? []).map((s) => s.siteId),
      ...(history?.sites ?? []).map((s) => s.siteId),
    ]);
    return Array.from(ids).map((id) => ({
      site:
        siteById.get(id) ??
        ({ id, name: id, url: "", propertyId: "" } satisfies SiteConfig),
      realtime: realtime?.sites.find((s) => s.siteId === id),
      history: history?.sites.find((s) => s.siteId === id),
    }));
  }, [sites, siteById, realtime, history]);

  // 全站分钟趋势（对成功站点的分钟序列求和）
  const minuteTrend = useMemo(() => {
    const okSites = (realtime?.sites ?? []).filter((s) => !s.error && s.trend.length > 0);
    if (okSites.length === 0) return [];
    const total = new Map<number, { users: number; pageviews: number }>();
    for (const site of okSites) {
      for (const point of site.trend) {
        const hit = total.get(point.minutesAgo) ?? { users: 0, pageviews: 0 };
        total.set(point.minutesAgo, {
          users: hit.users + point.activeUsers,
          pageviews: hit.pageviews + point.pageviews,
        });
      }
    }
    return Array.from(total.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([minutesAgo, v]) => ({
        label: minutesAgo === 0 ? "现在" : `-${minutesAgo}分`,
        users: v.users,
        pageviews: v.pageviews,
      }));
  }, [realtime]);

  // 历史趋势（选中范围）
  const historyTrend = useMemo(() => {
    if (!history) return [];
    if (range === "today" || range === "yesterday") {
      // 逐小时合计：site.hourly 已含昨日+今日，按 date|hour 聚合
      const okSites = history.sites.filter((s) => !s.error);
      const agg = new Map<string, number>();
      const aggPv = new Map<string, number>();
      const labels = new Map<string, number>();
      for (const site of okSites) {
        for (const point of site.hourly) {
          const key = `${point.date}|${point.hour}`;
          agg.set(key, (agg.get(key) ?? 0) + point.users);
          aggPv.set(key, (aggPv.get(key) ?? 0) + point.pageviews);
          labels.set(key, point.hour);
        }
      }
      const targetDate = okSites[0]?.daily.at(range === "today" ? -1 : -2)?.date;
      if (!targetDate) return [];
      return Array.from(agg.entries())
        .filter(([key]) => key.startsWith(`${targetDate}|`))
        .sort((a, b) => labels.get(a[0])! - labels.get(b[0])!)
        .map(([key, users]) => ({
          label: `${String(labels.get(key)).padStart(2, "0")}时`,
          users,
          pageviews: aggPv.get(key) ?? 0,
        }));
    }
    // 近 7 天/30 天：逐日合计（各站点 daily 按日期对齐）
    const okSites = history.sites.filter((s) => !s.error);
    const aggUsers = new Map<string, number>();
    const aggPv = new Map<string, number>();
    for (const site of okSites) {
      for (const point of site.daily.slice(range === "7d" ? -7 : -30)) {
        aggUsers.set(point.date, (aggUsers.get(point.date) ?? 0) + point.users);
        aggPv.set(point.date, (aggPv.get(point.date) ?? 0) + point.pageviews);
      }
    }
    return Array.from(aggUsers.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, users]) => ({
        label: date.slice(5).replace("-", "/"),
        users,
        pageviews: aggPv.get(date) ?? 0,
      }));
  }, [history, range]);
  // 排名
  const ranking = useMemo(() => {
    if (!history) return [];
    const ok = history.sites.filter((s) => !s.error);
    const entries = ok.map((s) => ({
      siteId: s.siteId,
      name: siteById.get(s.siteId)?.name ?? s.siteId,
      value: s[PERIOD_KEY[range]][rankMetric],
    }));
    const max = Math.max(...entries.map((e) => e.value), 1);
    return entries
      .sort((a, b) => b.value - a.value)
      .map((e) => ({ ...e, share: e.value / max }));
  }, [history, range, rankMetric, siteById]);

  const realtimeTotal = realtime?.totals;
  const todayTotals = history?.totals.today;
  const last7Totals = history?.totals.last7;

  return (
    <div className="space-y-5">
      {/* 顶部：标题 + 更新时间 + 刷新 */}
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">流量概览</h1>
          <p className="mt-0.5 text-xs text-slate-400 dark:text-zinc-500">
            实时数据每 60 秒自动刷新
            {realtime ? ` · 更新于 ${formatTime(realtime.fetchedAt)}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void manualRefresh()}
          disabled={refreshing}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          <span className={refreshing ? "inline-block animate-spin" : "inline-block"}>⟳</span>
          {refreshing ? "刷新中…" : "手动刷新"}
        </button>
      </div>

      <StateHint loading={loading && !realtime && !history} error={error} />

      {/* 全局提示：凭据 / KV */}
      {health && !health.credentialsConfigured && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-400">
          ⚠️ {health.credentialsError ?? "尚未配置 GA4 服务账号凭据"} —— 配置方法见 docs/DEPLOYMENT.md
        </div>
      )}
      {health?.kvWarning && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-400">
          ⚠️ {health.kvWarning}
        </div>
      )}

      {/* 实时指标卡 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="实时活跃用户（30 分钟）"
          value={realtime ? formatNumber(realtimeTotal?.activeUsers ?? 0) : "…"}
          hint={`${sites.length || "—"} 个站点`}
          accent
        />
        <StatCard label="30 分钟 PV" value={realtime ? formatNumber(realtimeTotal?.pageviews ?? 0) : "…"} />
        <StatCard
          label="今日 UV"
          value={history ? formatNumber(todayTotals?.users ?? 0) : "…"}
          hint={history ? `PV ${formatNumber(todayTotals?.pageviews ?? 0)}` : undefined}
        />
        <StatCard
          label="近 7 天 UV"
          value={history ? formatNumber(last7Totals?.users ?? 0) : "…"}
          hint={history ? `PV ${formatNumber(last7Totals?.pageviews ?? 0)}` : undefined}
        />
      </div>

      {/* 全站分钟趋势 */}
      <Card title="全站实时活跃趋势（过去 30 分钟）">
        <MinuteTrendChart data={minuteTrend} />
      </Card>

      {/* 主表格 */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-zinc-200">全部站点</h2>
          <span className="text-xs text-slate-400 dark:text-zinc-500">点击行查看站点详情 · 点击列头排序</span>
        </div>
        <SiteTable rows={rows} loading={loading} />
      </div>

      {/* 历史趋势 + 排名 */}
      <div className="grid gap-4 xl:grid-cols-5">
        <Card
          className="xl:col-span-3"
          title={`流量趋势 · ${RANGE_OPTIONS.find((o) => o.value === range)?.label ?? ""}`}
          actions={
            <RangeTabs
              value={range}
              onChange={(v) => {
                setRange(v);
                if (v !== "today" && v !== "yesterday" && rankMetric !== "pageviews") setRankMetric("pageviews");
              }}
              options={RANGE_OPTIONS}
            />
          }
        >
          <HistoryTrendChart data={historyTrend} />
        </Card>

        <Card
          className="xl:col-span-2"
          title="站点排名"
          actions={
            <div className="flex items-center gap-2">
              <RangeTabs
                value={range}
                onChange={setRange}
                options={RANGE_OPTIONS}
              />
              <RangeTabs
                value={rankMetric}
                onChange={setRankMetric}
                options={[
                  { value: "pageviews", label: "PV" },
                  { value: "users", label: "UV" },
                ]}
              />
            </div>
          }
        >
          {ranking.length === 0 ? (
            <StateHint loading={loading} empty="暂无可排名的站点数据" />
          ) : (
            <ol className="space-y-2.5">
              {ranking.map((entry, index) => (
                <li key={entry.siteId}>
                  <a href={`/sites/${entry.siteId}`} className="group block">
                    <div className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5 font-medium text-slate-700 group-hover:text-indigo-600 dark:text-zinc-200 dark:group-hover:text-indigo-400">
                        <span className="tnum w-4 text-slate-400 dark:text-zinc-500">{index + 1}</span>
                        {entry.name}
                      </span>
                      <span className="tnum text-slate-500 dark:text-zinc-400">{formatNumber(entry.value)}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-zinc-800">
                      <div
                        className="h-full rounded-full bg-indigo-500 transition-all"
                        style={{ width: `${Math.max(entry.share * 100, 2)}%` }}
                      />
                    </div>
                  </a>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </div>
  );
}
