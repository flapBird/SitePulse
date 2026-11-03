/**
 * GA4 返回行 → 业务统计的聚合引擎。
 *
 * 全部为纯函数：输入原始报表行/时区/阈值，输出 SiteHistory / SiteRealtime /
 * SiteDetail 等前端直接可用的结构。缺失日期/小时补零；所有「今日/昨日/同期」
 * 均按站点配置的时区（与 GA4 Property 报告时区一致）计算。
 */

import { formatGaDate, gaDateCompact, zonedElapsedHour } from "./datetime";
import type {
  Anomaly,
  BreakdownRow,
  DailyPoint,
  HistoryPeriod,
  HourlyPoint,
  MetricSet,
  RangeKey,
  RealtimePoint,
  SiteDetail,
  SiteHistory,
  SiteRealtime,
} from "./types";
import type { GaRow, GaRunReportResponse } from "./ga4";

const EMPTY: MetricSet = { users: 0, pageviews: 0, sessions: 0 };

function num(value: string | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function rowToMetricSet(row: GaRow): MetricSet {
  const values = row.metricValues ?? [];
  return {
    users: num(values[0]?.value),
    pageviews: num(values[1]?.value),
    sessions: num(values[2]?.value),
  };
}

function addMetric(a: MetricSet, b: MetricSet): MetricSet {
  return {
    users: a.users + b.users,
    pageviews: a.pageviews + b.pageviews,
    sessions: a.sessions + b.sessions,
  };
}

/** 环比变化率：基期为 0/无数据时返回 null（避免误导性的「∞」） */
export function pctChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return (current - previous) / previous;
}

function toPeriod(current: MetricSet, previous: MetricSet): HistoryPeriod {
  return {
    ...current,
    prev: previous,
    usersChangePct: pctChange(current.users, previous.users),
    pageviewsChangePct: pctChange(current.pageviews, previous.pageviews),
  };
}

// ---------------------------------------------------------------------------
// 历史统计
// ---------------------------------------------------------------------------

export interface HistoryInput {
  siteId: string;
  /** 60 天逐日报表：dateRanges=[gaDate(-59)..gaDate(0)]，dims=[date] */
  dailyReport: GaRunReportResponse;
  /** 昨日+今日逐小时报表：dateRanges=[gaDate(-1)..gaDate(0)]，dims=[dateHour] */
  hourlyReport: GaRunReportResponse;
  /** 与 GA4 Property 一致的 IANA 时区 */
  timeZone: string;
  threshold: number;
  now?: Date;
}

const DAILY_WINDOW = 60; // 近 60 天（近 30 天 + 前 30 天对比）

export function buildSiteHistory(input: HistoryInput): SiteHistory {
  const now = input.now ?? new Date();
  const elapsedHour = zonedElapsedHour(input.timeZone, now);

  // ---- 逐日 ----
  const dailyMap = new Map<string, MetricSet>();
  for (const row of input.dailyReport.rows ?? []) {
    const date = row.dimensionValues?.[0]?.value;
    if (!date) continue;
    dailyMap.set(formatGaDate(date), addMetric(dailyMap.get(formatGaDate(date)) ?? EMPTY, rowToMetricSet(row)));
  }
  const daily: DailyPoint[] = [];
  for (let offset = -(DAILY_WINDOW - 1); offset <= 0; offset += 1) {
    const date = gaDateCompact(offset, input.timeZone, now);
    const formatted = formatGaDate(date);
    const metrics = dailyMap.get(formatted) ?? EMPTY;
    daily.push({ date: formatted, ...metrics });
  }
  const byOffset = (offset: number): MetricSet => daily[daily.length - 1 + offset] ?? EMPTY;

  const today = byOffset(0);
  const yesterday = byOffset(-1);
  const dayBeforeYesterday = byOffset(-2);

  const sumRange = (fromOffset: number, toOffset: number): MetricSet => {
    let acc = EMPTY;
    for (let offset = fromOffset; offset <= toOffset; offset += 1) acc = addMetric(acc, byOffset(offset));
    return acc;
  };

  // ---- 逐小时（昨日 + 今日） ----
  const hourlyMap = new Map<string, MetricSet>();
  for (const row of input.hourlyReport.rows ?? []) {
    const dateHour = row.dimensionValues?.[0]?.value ?? "";
    if (dateHour.length !== 10) continue;
    const key = `${formatGaDate(dateHour.slice(0, 8))}|${Number(dateHour.slice(8, 10))}`;
    hourlyMap.set(key, addMetric(hourlyMap.get(key) ?? EMPTY, rowToMetricSet(row)));
  }
  const hourly: HourlyPoint[] = [];
  for (const offset of [-1, 0]) {
    const date = formatGaDate(gaDateCompact(offset, input.timeZone, now));
    const lastHour = offset === 0 ? elapsedHour : 23;
    for (let hour = 0; hour <= lastHour; hour += 1) {
      const metrics = hourlyMap.get(`${date}|${hour}`) ?? EMPTY;
      hourly.push({ date, hour, ...metrics });
    }
  }

  const sumHours = (date: string, upToHour: number): MetricSet => {
    let acc = EMPTY;
    for (const point of hourly) {
      if (point.date === date && point.hour <= upToHour) acc = addMetric(acc, point);
    }
    return acc;
  };

  const todayDate = formatGaDate(gaDateCompact(0, input.timeZone, now));
  const yesterdayDate = formatGaDate(gaDateCompact(-1, input.timeZone, now));
  // 今日已过完整小时（不含进行中的当前小时），昨日取相同钟点对比
  const sameTimeToday = sumHours(todayDate, Math.max(0, elapsedHour - 1));
  const sameTimeYesterday = sumHours(yesterdayDate, Math.max(0, elapsedHour - 1));

  const periods = {
    today: toPeriod(today, yesterday),
    yesterday: toPeriod(yesterday, dayBeforeYesterday),
    last7: toPeriod(sumRange(-6, 0), sumRange(-13, -7)),
    last30: toPeriod(sumRange(-29, 0), sumRange(-59, -30)),
  };

  const history: SiteHistory = {
    siteId: input.siteId,
    ...periods,
    daily,
    hourly,
    sameTimeToday,
    sameTimeYesterday,
    fetchedAt: now.toISOString(),
  };
  const anomaly = detectAnomaly({
    sameTimeToday,
    sameTimeYesterday,
    last7: periods.last7,
    last30: periods.last30,
    threshold: input.threshold,
  });
  if (anomaly) history.anomaly = anomaly;
  return history;
}

/** 异常检测：优先「今日 vs 昨日同期」，其次近 7 天、近 30 天环比 */
export function detectAnomaly(params: {
  sameTimeToday: MetricSet;
  sameTimeYesterday: MetricSet;
  last7: HistoryPeriod;
  last30: HistoryPeriod;
  threshold: number;
}): Anomaly | undefined {
  const threshold = params.threshold;
  const candidates: Anomaly[] = [];

  const baseline = params.sameTimeYesterday;
  if (baseline.pageviews > 0 || baseline.users > 0) {
    const pct = pctChange(params.sameTimeToday.pageviews, baseline.pageviews);
    if (pct != null) candidates.push({ direction: pct >= 0 ? "up" : "down", changePct: pct, basis: "today_same_time" });
  }
  for (const [period, basis] of [
    [params.last7, "last7"],
    [params.last30, "last30"],
  ] as const) {
    const pct = period.pageviewsChangePct ?? period.usersChangePct;
    if (pct != null) candidates.push({ direction: pct >= 0 ? "up" : "down", changePct: pct, basis });
  }

  return candidates.find((c) => Math.abs(c.changePct) >= threshold);
}

// ---------------------------------------------------------------------------
// 实时数据
// ---------------------------------------------------------------------------

export interface RealtimeInput {
  siteId: string;
  /** 30 分钟总量报表：无维度，metrics=[activeUsers, screenPageViews] */
  totalsReport: GaRunReportResponse;
  /** 分钟级报表：dims=[minutesAgo]，metrics=[activeUsers, screenPageViews] */
  minuteReport: GaRunReportResponse;
  now?: Date;
}

export function buildSiteRealtime(input: RealtimeInput): SiteRealtime {
  const totals = (input.totalsReport.rows ?? [])[0];
  const totalsMetrics = totals ? rowToMetricSet(totals) : EMPTY;

  const byMinute = new Map<number, { activeUsers: number; pageviews: number }>();
  for (const row of input.minuteReport.rows ?? []) {
    const minutesAgo = Number(row.dimensionValues?.[0]?.value);
    if (!Number.isFinite(minutesAgo)) continue;
    const values = row.metricValues ?? [];
    const prev = byMinute.get(minutesAgo);
    byMinute.set(minutesAgo, {
      activeUsers: (prev?.activeUsers ?? 0) + num(values[0]?.value),
      pageviews: (prev?.pageviews ?? 0) + num(values[1]?.value),
    });
  }
  // 30 分钟窗口，从 29 分钟前到当前分钟，缺失分钟补零
  const trend: RealtimePoint[] = [];
  for (let minutesAgo = 29; minutesAgo >= 0; minutesAgo -= 1) {
    const hit = byMinute.get(minutesAgo);
    trend.push({
      minutesAgo,
      activeUsers: hit?.activeUsers ?? 0,
      pageviews: hit?.pageviews ?? 0,
    });
  }

  return {
    siteId: input.siteId,
    activeUsers: totalsMetrics.users,
    pageviews: totalsMetrics.pageviews,
    trend,
    fetchedAt: (input.now ?? new Date()).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 站点详情
// ---------------------------------------------------------------------------

export interface DetailInput {
  siteId: string;
  range: RangeKey;
  /** 范围合计报表：无维度，metrics=[totalUsers, screenPageViews, sessions] */
  totalsReport: GaRunReportResponse;
  /** 逐日报表（范围内，dims=[date]），用于趋势曲线 */
  dailyReport: GaRunReportResponse;
  countriesReport: GaRunReportResponse;
  devicesReport: GaRunReportResponse;
  pagesReport: GaRunReportResponse;
  sourcesReport: GaRunReportResponse;
  timeZone: string;
  now?: Date;
}

function breakdownFromReport(
  report: GaRunReportResponse,
  options: { labelIndex?: number; transformKey?: (key: string) => string } = {},
): BreakdownRow[] {
  const rows: BreakdownRow[] = [];
  for (const row of report.rows ?? []) {
    const dims = row.dimensionValues ?? [];
    const key = dims[0]?.value ?? "(unknown)";
    const label = options.labelIndex != null ? dims[options.labelIndex]?.value || undefined : undefined;
    const metrics = rowToMetricSet(row);
    rows.push({
      key: options.transformKey ? options.transformKey(key) : key,
      label,
      users: metrics.users,
      pageviews: metrics.pageviews,
    });
  }
  return rows;
}

export function buildSiteDetail(input: DetailInput): SiteDetail {
  const now = input.now ?? new Date();

  const totalsRow = (input.totalsReport.rows ?? [])[0];
  const totals = totalsRow ? rowToMetricSet(totalsRow) : EMPTY;

  const daily: DailyPoint[] = (input.dailyReport.rows ?? [])
    .map((row) => {
      const date = row.dimensionValues?.[0]?.value ?? "";
      return { date: formatGaDate(date), ...rowToMetricSet(row) };
    })
    .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    siteId: input.siteId,
    range: input.range,
    totals,
    daily,
    countries: breakdownFromReport(input.countriesReport),
    devices: breakdownFromReport(input.devicesReport),
    pages: breakdownFromReport(input.pagesReport),
    sources: breakdownFromReport(input.sourcesReport, { labelIndex: 1 }),
    fetchedAt: now.toISOString(),
  };
}
