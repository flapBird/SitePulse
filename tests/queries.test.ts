import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceAccountCredentials } from "../lib/ga4";

// 捕获发往 GA4 模块的请求体，断言请求结构（尤其是 orderBys 的字段层级）
type AnyRecord = Record<string, unknown>;
const runRealtimeReportMock = vi.fn(async (..._args: unknown[]) => ({ rows: [] }));
const batchRunReportsMock = vi.fn(async (..._args: unknown[]) => ({
  reports: [{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }],
}));
const runReportMock = vi.fn(async (..._args: unknown[]) => ({ rows: [] }));

vi.mock("../lib/ga4", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ga4")>();
  return {
    ...actual,
    runRealtimeReport: (...args: unknown[]) => runRealtimeReportMock(...(args as [])),
    batchRunReports: (...args: unknown[]) => batchRunReportsMock(...(args as [])),
    runReport: (...args: unknown[]) => runReportMock(...(args as [])),
  };
});

const { fetchSiteDetail, fetchSiteRealtime } = await import("../lib/queries");

const cred: ServiceAccountCredentials = { client_email: "a@b.c", private_key: "x" };
const site = { id: "t", name: "T", url: "https://t.com", propertyId: "123456" };

describe("GA4 请求结构（防回归）", () => {
  beforeEach(() => {
    runRealtimeReportMock.mockClear();
    batchRunReportsMock.mockClear();
    runReportMock.mockClear();
  });

  it("detail 的 orderBys：desc 必须在 OrderBy 层级，不能进 metric 内部", async () => {
    await fetchSiteDetail(cred, site, "7d", new Date("2026-11-05T04:00:00Z"));
    expect(batchRunReportsMock).toHaveBeenCalledTimes(1);
    const [, , requests] = batchRunReportsMock.mock.calls[0] as unknown as [AnyRecord, AnyRecord, AnyRecord[]];
    for (const req of requests) {
      for (const orderBy of (req.orderBys ?? []) as Record<string, unknown>[]) {
        if (orderBy.metric) {
          // MetricOrderBy 只允许 metricName
          expect(Object.keys(orderBy.metric).sort()).toEqual(["metricName"]);
          expect(orderBy.desc).toBe(true);
        }
      }
    }
  });

  it("realtime 请求使用 minuteRanges 且无 dateRanges", async () => {
    await fetchSiteRealtime(cred, site, new Date());
    expect(runRealtimeReportMock).toHaveBeenCalledTimes(2);
    for (const call of runRealtimeReportMock.mock.calls) {
      const request = call[2] as AnyRecord;
      expect(request.dateRanges).toBeUndefined();
      expect(request.minuteRanges).toEqual([{ startMinutesAgo: 29, endMinutesAgo: 0 }]);
      for (const orderBy of (request.orderBys ?? []) as Record<string, unknown>[]) {
        if (orderBy.dimension) {
          expect(Object.keys(orderBy.dimension)).toContain("dimensionName");
        }
      }
    }
  });

  it("history 批量包含逐日与逐小时两个子报表", async () => {
    const { fetchSiteHistory } = await import("../lib/queries");
    await fetchSiteHistory(cred, site, 0.3, new Date("2026-11-05T04:00:00Z"));
    expect(batchRunReportsMock).toHaveBeenCalledTimes(1);
    const [, , requests] = batchRunReportsMock.mock.calls[0] as unknown as [
      ServiceAccountCredentials,
      string,
      Record<string, unknown>[],
    ];
    expect(requests).toHaveLength(2);
    expect(requests[0].dimensions).toEqual([{ name: "date" }]);
    expect(requests[1].dimensions).toEqual([{ name: "dateHour" }]);
    expect(batchRunReportsMock.mock.results[0].value).toBeInstanceOf(Promise);
  });
});
