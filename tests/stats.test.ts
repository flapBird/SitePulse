import { describe, expect, it } from "vitest";
import { buildSiteDetail, buildSiteHistory, buildSiteRealtime, detectAnomaly, pctChange } from "../lib/stats";
import type { GaRunReportResponse, GaRow } from "../lib/ga4";
import type { HistoryPeriod, MetricSet } from "../lib/types";

/** Asia/Shanghai 2026-11-04 18:20（当天已过完整小时 0..17） */
const NOW = new Date("2026-11-04T10:20:00Z");
const TZ = "Asia/Shanghai";

function metricRow(dimension: string[] | undefined, users: number, pv: number, sessions = 0): GaRow {
  return {
    dimensionValues: dimension?.map((value) => ({ value })),
    metricValues: [{ value: String(users) }, { value: String(pv) }, { value: String(sessions) }],
  };
}

function dailyReport(rows: GaRow[]): GaRunReportResponse {
  return { rows };
}

describe("buildSiteHistory", () => {
  const rows: GaRow[] = [
    // 今天 2026-11-04
    metricRow(["20261104"], 100, 200, 30),
    // 昨天 2026-11-03
    metricRow(["20261103"], 80, 150, 20),
    // 3 天前 2026-11-01（中间 11-02 缺失应补零）
    metricRow(["20261101"], 10, 10, 5),
  ];

  const history = buildSiteHistory({
    siteId: "test",
    dailyReport: dailyReport(rows),
    hourlyReport: dailyReport([
      // 今日 0..17 累计 PV 120 / UV 60
      ...Array.from({ length: 18 }, (_, hour) => metricRow([`20261104${String(hour).padStart(2, "0")}`], 60 / 18, 120 / 18, 10)),
      // 昨日全天
      ...Array.from({ length: 24 }, (_, hour) => metricRow([`20261103${String(hour).padStart(2, "0")}`], 80 / 24, 150 / 24, 20 / 24)),
    ]),
    timeZone: TZ,
    threshold: 0.3,
    now: NOW,
  });

  it("补齐 60 天并按时间升序", () => {
    expect(history.daily).toHaveLength(60);
    expect(history.daily[0].date).toBe("2026-09-06");
    expect(history.daily[59].date).toBe("2026-11-04");
  });

  it("今日/昨日取自对应日期", () => {
    expect(history.today).toMatchObject({ users: 100, pageviews: 200, sessions: 30 });
    expect(history.yesterday).toMatchObject({ users: 80, pageviews: 150 });
    // 今日 vs 昨日：UV +25%，PV +33.3%
    expect(history.today.usersChangePct).toBeCloseTo(0.25, 5);
    expect(history.today.pageviewsChangePct).toBeCloseTo(1 / 3, 5);
  });

  it("昨日环比基期为 0 时变化率为 null", () => {
    // 11-02 无数据 → 昨日的 prev 是 0
    expect(history.yesterday.prev.users).toBe(0);
    expect(history.yesterday.usersChangePct).toBeNull();
  });

  it("近 7 天汇总（缺失日补零）", () => {
    expect(history.last7.users).toBe(190);
    expect(history.last7.pageviews).toBe(360);
    // 前 7 天（10-22..10-28）无数据 → null
    expect(history.last7.usersChangePct).toBeNull();
  });

  it("近 30 天与前 30 天", () => {
    expect(history.last30.users).toBe(190);
    expect(history.last30.prev.users).toBe(0);
  });

  it("逐小时：昨日 24 点 + 今日至当前小时，缺失补零", () => {
    expect(history.hourly).toHaveLength(24 + 19);
    expect(history.hourly[0]).toMatchObject({ date: "2026-11-03", hour: 0 });
    expect(history.hourly[history.hourly.length - 1]).toMatchObject({ date: "2026-11-04", hour: 18 });
  });

  it("今日 vs 昨日同期", () => {
    expect(history.sameTimeToday.pageviews).toBeCloseTo(120, 5);
    expect(history.sameTimeYesterday.pageviews).toBeCloseTo((150 / 24) * 18, 5);
  });

  it("当日流量翻倍触发异常（今日 vs 昨日同期）", () => {
    // 今日同期 PV 120 vs 昨日同期 PV 112.5 → 未达 30% 阈值；改用单测直接验证 detectAnomaly
    const anomaly = detectAnomaly({
      sameTimeToday: { users: 0, pageviews: 200, sessions: 0 },
      sameTimeYesterday: { users: 0, pageviews: 100, sessions: 0 },
      last7: emptyPeriod(),
      last30: emptyPeriod(),
      threshold: 0.3,
    });
    expect(anomaly).toEqual({ direction: "up", changePct: 1, basis: "today_same_time" });
  });

  it("同期无基线时回退到 7 天环比", () => {
    const anomaly = detectAnomaly({
      sameTimeToday: { users: 0, pageviews: 10, sessions: 0 },
      sameTimeYesterday: { users: 0, pageviews: 0, sessions: 0 },
      last7: periodWithPvChange(130, 100),
      last30: emptyPeriod(),
      threshold: 0.3,
    });
    expect(anomaly).toEqual({ direction: "up", changePct: 0.3, basis: "last7" });
  });

  it("变化低于阈值不标记", () => {
    const anomaly = detectAnomaly({
      sameTimeToday: { users: 0, pageviews: 110, sessions: 0 },
      sameTimeYesterday: { users: 0, pageviews: 100, sessions: 0 },
      last7: periodWithPvChange(100, 100),
      last30: emptyPeriod(),
      threshold: 0.3,
    });
    expect(anomaly).toBeUndefined();
  });
});

describe("buildSiteRealtime", () => {
  const realtime = buildSiteRealtime({
    siteId: "test",
    totalsReport: { rows: [metricRow(undefined, 12, 34)] },
    minuteReport: {
      rows: [
        metricRow(["29"], 5, 8),
        metricRow(["28"], 7, 9),
        metricRow(["0"], 3, 2),
      ],
    },
    now: NOW,
  });

  it("总量取自无维度报表", () => {
    expect(realtime.activeUsers).toBe(12);
    expect(realtime.pageviews).toBe(34);
  });

  it("分钟趋势 30 个点、升序（29 分钟前 → 当前）、缺失补零", () => {
    expect(realtime.trend).toHaveLength(30);
    expect(realtime.trend[0]).toEqual({ minutesAgo: 29, activeUsers: 5, pageviews: 8 });
    expect(realtime.trend[1]).toEqual({ minutesAgo: 28, activeUsers: 7, pageviews: 9 });
    expect(realtime.trend[5]).toEqual({ minutesAgo: 24, activeUsers: 0, pageviews: 0 });
    expect(realtime.trend[29]).toEqual({ minutesAgo: 0, activeUsers: 3, pageviews: 2 });
  });
});

describe("buildSiteDetail", () => {
  const detail = buildSiteDetail({
    siteId: "test",
    range: "7d",
    totalsReport: { rows: [metricRow(undefined, 1000, 2000, 500)] },
    dailyReport: {
      rows: [metricRow(["20261103"], 10, 20), metricRow(["20261102"], 5, 7)],
    },
    countriesReport: { rows: [metricRow(["China"], 800, 1500), metricRow(["United States"], 150, 400)] },
    devicesReport: { rows: [metricRow(["desktop"], 700, 1400), metricRow(["mobile"], 280, 560)] },
    pagesReport: { rows: [metricRow(["/home"], 600, 1200), metricRow(["/posts/a"], 200, 300)] },
    sourcesReport: {
      rows: [metricRow(["Organic Search", "google / organic"], 500, 900), metricRow(["Direct", "(direct) / (none)"], 300, 600)],
    },
    timeZone: TZ,
    now: NOW,
  });

  it("合计与逐日", () => {
    expect(detail.totals).toEqual({ users: 1000, pageviews: 2000, sessions: 500 });
    expect(detail.daily.map((d) => d.date)).toEqual(["2026-11-02", "2026-11-03"]);
  });

  it("维度行与来源的双列结构", () => {
    expect(detail.countries[0]).toEqual({ key: "China", users: 800, pageviews: 1500 });
    expect(detail.devices[1].key).toBe("mobile");
    expect(detail.pages[1].key).toBe("/posts/a");
    expect(detail.sources[0]).toEqual({ key: "Organic Search", label: "google / organic", users: 500, pageviews: 900 });
  });
});

describe("pctChange", () => {
  it("基期为 0 返回 null", () => {
    expect(pctChange(10, 0)).toBeNull();
    expect(pctChange(0, 0)).toBeNull();
  });

  it("常规变化率", () => {
    expect(pctChange(150, 100)).toBeCloseTo(0.5, 10);
    expect(pctChange(50, 100)).toBeCloseTo(-0.5, 10);
  });
});

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

function periodWithPvChange(currentPv: number, prevPv: number): HistoryPeriod {
  const base = emptyPeriod();
  const metrics = (pv: number): MetricSet => ({ users: 0, pageviews: pv, sessions: 0 });
  return {
    ...base,
    pageviews: currentPv,
    prev: metrics(prevPv),
    pageviewsChangePct: pctChange(currentPv, prevPv),
  };
}
