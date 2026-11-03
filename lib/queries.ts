/**
 * 站点级数据查询：GA4 请求构造 + 错误捕获 + 聚合。
 * 每个函数返回「总是成功」的结果对象（错误挂在 error 字段上），
 * 保证单个站点故障不影响其他站点。
 */

import { mapWithConcurrency } from "./async";
import { zonedDate } from "./datetime";
import {
  batchRunReports,
  Ga4ApiError,
  runRealtimeReport,
  runReport,
  type GaRunReportRequest,
  type ServiceAccountCredentials,
} from "./ga4";
import { DEFAULT_TIME_ZONE } from "./sites";
import { buildSiteDetail, buildSiteHistory, buildSiteRealtime } from "./stats";
import type {
  ApiError,
  HistoryPeriod,
  RangeKey,
  SiteConfig,
  SiteDetail,
  SiteHistory,
  SiteRealtime,
} from "./types";

/** 同时在途的站点查询数上限 */
const MAX_CONCURRENCY = 8;

function timeZoneOf(site: SiteConfig): string {
  return site.timeZone?.trim() || DEFAULT_TIME_ZONE;
}

/** 把任意异常转成挂到站点数据上的 ApiError */
export function toApiError(err: unknown): ApiError {
  if (err instanceof Ga4ApiError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { code: "UNKNOWN", message: `查询失败：${err.message}` };
  }
  return { code: "UNKNOWN", message: "查询失败：未知错误" };
}

// ---------------------------------------------------------------------------
// 实时（每站点 2 次 runRealtimeReport，并行）
// ---------------------------------------------------------------------------

export async function fetchSiteRealtime(
  cred: ServiceAccountCredentials,
  site: SiteConfig,
  now: Date = new Date(),
): Promise<SiteRealtime> {
  const metrics = [{ name: "activeUsers" }, { name: "screenPageViews" }];
  try {
    const [totalsReport, minuteReport] = await Promise.all([
      runRealtimeReport(cred, site.propertyId, {
        metrics,
        minuteRanges: [{ startMinutesAgo: 29, endMinutesAgo: 0 }],
      }),
      runRealtimeReport(cred, site.propertyId, {
        dimensions: [{ name: "minutesAgo" }],
        metrics,
        minuteRanges: [{ startMinutesAgo: 29, endMinutesAgo: 0 }],
        orderBys: [{ dimension: { dimensionName: "minutesAgo" } }],
        limit: 31,
      }),
    ]);
    return buildSiteRealtime({ siteId: site.id, totalsReport, minuteReport, now });
  } catch (err) {
    return { siteId: site.id, activeUsers: 0, pageviews: 0, trend: [], error: toApiError(err), fetchedAt: now.toISOString() };
  }
}

// ---------------------------------------------------------------------------
// 历史（每站点 1 次 batchRunReports，含 2 个子报表）
// ---------------------------------------------------------------------------

export async function fetchSiteHistory(
  cred: ServiceAccountCredentials,
  site: SiteConfig,
  threshold: number,
  now: Date = new Date(),
): Promise<SiteHistory> {
  const tz = timeZoneOf(site);
  const metrics = [{ name: "totalUsers" }, { name: "screenPageViews" }, { name: "sessions" }];
  const dailyRequest: GaRunReportRequest = {
    dateRanges: [{ startDate: zonedDate(-59, tz, now), endDate: zonedDate(0, tz, now) }],
    dimensions: [{ name: "date" }],
    metrics,
    keepEmptyRows: true,
  };
  const hourlyRequest: GaRunReportRequest = {
    dateRanges: [{ startDate: zonedDate(-1, tz, now), endDate: zonedDate(0, tz, now) }],
    dimensions: [{ name: "dateHour" }],
    metrics,
    keepEmptyRows: true,
  };

  try {
    const batch = await batchRunReports(cred, site.propertyId, [dailyRequest, hourlyRequest]);
    const [dailyReport, hourlyReport] = batch.reports;
    if (!dailyReport || !hourlyReport) {
      throw new Ga4ApiError("REQUEST", "GA4 批量报表返回数量不足");
    }
    return buildSiteHistory({
      siteId: site.id,
      dailyReport,
      hourlyReport,
      timeZone: tz,
      threshold,
      now,
    });
  } catch (err) {
    return emptySiteHistory(site.id, toApiError(err), now.toISOString());
  }
}

function emptyPeriod(): HistoryPeriod {
  return {
    users: 0,
    pageviews: 0,
    sessions: 0,
    prev: { users: 0, pageviews: 0, sessions: 0 },
    usersChangePct: null,
    pageviewsChangePct: null,
  };
}

/** 查询失败时的空历史结构（与成功结构同形，错误挂在 error 上） */
function emptySiteHistory(siteId: string, error: ApiError, fetchedAt: string): SiteHistory {
  return {
    siteId,
    today: emptyPeriod(),
    yesterday: emptyPeriod(),
    last7: emptyPeriod(),
    last30: emptyPeriod(),
    daily: [],
    hourly: [],
    sameTimeToday: { users: 0, pageviews: 0, sessions: 0 },
    sameTimeYesterday: { users: 0, pageviews: 0, sessions: 0 },
    error,
    fetchedAt,
  };
}

// ---------------------------------------------------------------------------
// 站点详情（1 次 batchRunReports + 1 次 runReport，并行）
// ---------------------------------------------------------------------------

export const DETAIL_RANGE_LABELS: Record<RangeKey, string> = {
  today: "今日",
  yesterday: "昨日",
  "7d": "近 7 天",
  "30d": "近 30 天",
};

export function detailDateRange(range: RangeKey, timeZone: string, now: Date): { startDate: string; endDate: string } {
  switch (range) {
    case "today":
      return { startDate: zonedDate(0, timeZone, now), endDate: zonedDate(0, timeZone, now) };
    case "yesterday":
      return { startDate: zonedDate(-1, timeZone, now), endDate: zonedDate(-1, timeZone, now) };
    case "7d":
      return { startDate: zonedDate(-6, timeZone, now), endDate: zonedDate(0, timeZone, now) };
    case "30d":
      return { startDate: zonedDate(-29, timeZone, now), endDate: zonedDate(0, timeZone, now) };
  }
}

export async function fetchSiteDetail(
  cred: ServiceAccountCredentials,
  site: SiteConfig,
  range: RangeKey,
  now: Date = new Date(),
): Promise<SiteDetail> {
  const tz = timeZoneOf(site);
  const metrics = [{ name: "totalUsers" }, { name: "screenPageViews" }, { name: "sessions" }];
  const twoMetrics = [{ name: "totalUsers" }, { name: "screenPageViews" }];
  const dateRange = detailDateRange(range, tz, now);
  const dateRanges = [{ ...dateRange }];
  const orderByPv = [{ metric: { metricName: "screenPageViews", desc: true } }];

  try {
    const [totalsReport, batch] = await Promise.all([
      runReport(cred, site.propertyId, { dateRanges, metrics }),
      batchRunReports(cred, site.propertyId, [
        {
          dateRanges,
          dimensions: [{ name: "date" }],
          metrics,
          keepEmptyRows: true,
        },
        {
          dateRanges,
          dimensions: [{ name: "country" }],
          metrics: twoMetrics,
          orderBys: orderByPv,
          limit: 10,
        },
        {
          dateRanges,
          dimensions: [{ name: "deviceCategory" }],
          metrics: twoMetrics,
          orderBys: orderByPv,
          limit: 10,
        },
        {
          dateRanges,
          dimensions: [{ name: "pagePath" }],
          metrics: twoMetrics,
          orderBys: orderByPv,
          limit: 10,
        },
        {
          dateRanges,
          dimensions: [{ name: "sessionDefaultChannelGroup" }, { name: "sessionSourceMedium" }],
          metrics: twoMetrics,
          orderBys: orderByPv,
          limit: 10,
        },
      ]),
    ]);
    const [dailyReport, countriesReport, devicesReport, pagesReport, sourcesReport] = batch.reports;
    if (!dailyReport || !countriesReport || !devicesReport || !pagesReport || !sourcesReport) {
      throw new Ga4ApiError("REQUEST", "GA4 批量报表返回数量不足");
    }
    return buildSiteDetail({
      siteId: site.id,
      range,
      totalsReport,
      dailyReport,
      countriesReport,
      devicesReport,
      pagesReport,
      sourcesReport,
      timeZone: tz,
      now,
    });
  } catch (err) {
    return {
      siteId: site.id,
      range,
      totals: { users: 0, pageviews: 0, sessions: 0 },
      daily: [],
      countries: [],
      devices: [],
      pages: [],
      sources: [],
      error: toApiError(err),
      fetchedAt: now.toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// 多站点并发编排
// ---------------------------------------------------------------------------

export async function fetchAllSitesRealtime(
  cred: ServiceAccountCredentials,
  sites: SiteConfig[],
  now: Date = new Date(),
): Promise<SiteRealtime[]> {
  const settled = await mapWithConcurrency(sites, MAX_CONCURRENCY, (site) =>
    fetchSiteRealtime(cred, site, now),
  );
  return settled.map((s, index) =>
    s.status === "fulfilled"
      ? s.value
      : {
          siteId: sites[index].id,
          activeUsers: 0,
          pageviews: 0,
          trend: [],
          error: toApiError(s.reason),
          fetchedAt: now.toISOString(),
        },
  );
}

export async function fetchAllSitesHistory(
  cred: ServiceAccountCredentials,
  sites: SiteConfig[],
  threshold: number,
  now: Date = new Date(),
): Promise<SiteHistory[]> {
  const settled = await mapWithConcurrency(sites, MAX_CONCURRENCY, (site) =>
    fetchSiteHistory(cred, site, threshold, now),
  );
  return settled.map((s, index) =>
    s.status === "fulfilled"
      ? s.value
      : emptySiteHistory(sites[index].id, toApiError(s.reason), now.toISOString()),
  );
}
