import { describe, expect, it } from "vitest";
import {
  formatWindow,
  LOGIN_FUNNEL,
  normalizeFunnelResponse,
  PURCHASE_FUNNEL,
  type FunnelSpec,
} from "../lib/funnel";
import type { GaFunnelReportResponse } from "../lib/ga4";

/** 构造 v1alpha 真实形态的 funnelTable：8 个重复 metricHeaders、行值只有 4 个 */
function v1alphaTable(opts: {
  steps: { step: number; name: string; users: number }[];
  breakdown?: { dimension: string; values: string[] };
}): GaFunnelReportResponse {
  const metricHeaders = [
    "activeUsers",
    "funnelStepCompletionRate",
    "funnelStepAbandonments",
    "funnelStepAbandonmentRate",
  ].flatMap((name) => [
    { name, type: "TYPE_INTEGER" },
    { name, type: "TYPE_INTEGER" },
  ]);
  const dimensionHeaders = [{ name: "funnelStepName" }, { name: "segment" }];
  if (opts.breakdown) dimensionHeaders.push({ name: opts.breakdown.dimension });

  const rows = [];
  for (const step of opts.steps) {
    if (opts.breakdown) {
      for (const value of opts.breakdown.values) {
        // 0 人分组行也可能被省略——模拟真实行为：只有有数据的行
        rows.push({
          dimensionValues: [
            { value: `${step.step}. ${step.name}` },
            { value: "1. 排除内部账号" },
            { value },
          ],
          metricValues: [
            { value: String(step.users) },
            { value: "0.5" },
            { value: "0" },
            { value: "0.5" },
          ],
        });
      }
    } else {
      rows.push({
        dimensionValues: [{ value: `${step.step}. ${step.name}` }, { value: "1. 排除内部账号" }],
        metricValues: [
          { value: String(step.users) },
          { value: "0.5" },
          { value: "0" },
          { value: "0.5" },
        ],
      });
    }
  }
  return {
    funnelTable: {
      dimensionHeaders,
      metricHeaders,
      rows,
      metadata: {},
    },
  };
}

const BASE_INPUT = {
  siteId: "test-site",
  startDate: "2026-10-09",
  endDate: "2026-11-05",
  includesToday: true,
  now: new Date("2026-11-05T12:00:00Z"),
};

describe("formatWindow", () => {
  it("秒数转可读窗口", () => {
    expect(formatWindow(30 * 60)).toBe("30 分钟");
    expect(formatWindow(7 * 24 * 60 * 60)).toBe("7 天");
    expect(formatWindow(2 * 3_600)).toBe("2 小时");
  });
});

describe("normalizeFunnelResponse（登录漏斗）", () => {
  it("按 header 名称对齐（不按下标），正确读取重复 headers 下的 activeUsers", () => {
    const result = normalizeFunnelResponse({
      ...BASE_INPUT,
      spec: LOGIN_FUNNEL,
      response: v1alphaTable({
        steps: [
          { step: 1, name: "发起 Google 登录", users: 4 },
          { step: 2, name: "登录成功", users: 3 },
        ],
      }),
      breakdownDimension: null,
    });
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].users).toBe(4);
    expect(result.steps[1].users).toBe(3);
    expect(result.steps[1].stepRate).toBeCloseTo(0.75);
    expect(result.steps[1].dropped).toBe(1);
    expect(result.steps[1].dropRate).toBeCloseTo(0.25);
    expect(result.overallRate).toBeCloseTo(0.75);
  });

  it("0 人步骤整行省略时补零，转化率不可计算（不误报流失）", () => {
    const result = normalizeFunnelResponse({
      ...BASE_INPUT,
      spec: LOGIN_FUNNEL,
      response: v1alphaTable({ steps: [{ step: 1, name: "发起 Google 登录", users: 5 }] }),
      breakdownDimension: null,
    });
    expect(result.steps[1].users).toBe(0);
    expect(result.steps[1].stepRate).toBeCloseTo(0);
    expect(result.steps[1].dropped).toBe(5);
    expect(result.steps[1].dropRate).toBeCloseTo(1);
    expect(result.overallRate).toBeCloseTo(0);
  });

  it("首步 0 人（无任何行）时整体为空、比率为 null", () => {
    const result = normalizeFunnelResponse({
      ...BASE_INPUT,
      spec: LOGIN_FUNNEL,
      response: v1alphaTable({ steps: [] }),
      breakdownDimension: null,
    });
    expect(result.steps).toHaveLength(2);
    expect(result.steps.every((s) => s.users === 0)).toBe(true);
    expect(result.steps[1].stepRate).toBeNull();
    expect(result.steps[1].dropRate).toBeNull();
    expect(result.overallRate).toBeNull();
  });

  it("funnelTable 缺失时返回空结构", () => {
    const result = normalizeFunnelResponse({
      ...BASE_INPUT,
      spec: LOGIN_FUNNEL,
      response: {},
      breakdownDimension: null,
    });
    expect(result.steps).toHaveLength(2);
    expect(result.overallRate).toBeNull();
  });
});

describe("normalizeFunnelResponse（购买漏斗 + 拆分）", () => {
  it("RESERVED_TOTAL 总计行进入整体，分组行进入 breakdowns，不重复累加", () => {
    const spec = PURCHASE_FUNNEL;
    const result = normalizeFunnelResponse({
      ...BASE_INPUT,
      spec,
      response: v1alphaTable({
        steps: [
          { step: 1, name: "查看套餐", users: 10 },
          { step: 2, name: "点击购买", users: 6 },
          { step: 3, name: "创建结账", users: 3 },
          { step: 4, name: "支付成功", users: 2 },
        ],
        breakdown: { dimension: "deviceCategory", values: ["RESERVED_TOTAL", "desktop", "mobile"] },
      }),
      breakdownDimension: "deviceCategory",
    });
    // 整体来自 RESERVED_TOTAL 行
    expect(result.steps[0].users).toBe(10);
    expect(result.steps[1].users).toBe(6);
    expect(result.steps[2].users).toBe(3);
    expect(result.steps[3].users).toBe(2);
    expect(result.overallRate).toBeCloseTo(0.2);
    // 分组不含 RESERVED_TOTAL
    expect(result.breakdowns.map((b) => b.key)).toEqual(["desktop", "mobile"]);
    // 分组人数与总计行一致（同构测试数据）
    expect(result.breakdowns[0].steps[0].users).toBe(10);
    // 排除口径说明包含限制提示
    expect(result.exclusionNote).toContain("USER_EXCLUSION_PERMANENT");
    expect(result.exclusionNote).toContain("限制");
  });

  it("四步漏斗逐步推导流失与总体转化率", () => {
    const spec: FunnelSpec = {
      id: "test4",
      title: "四步测试",
      description: "",
      steps: PURCHASE_FUNNEL.steps,
      excludeInternal: false,
    };
    const result = normalizeFunnelResponse({
      ...BASE_INPUT,
      spec,
      response: v1alphaTable({
        steps: [
          { step: 1, name: "查看套餐", users: 100 },
          { step: 2, name: "点击购买", users: 40 },
          { step: 3, name: "创建结账", users: 20 },
          { step: 4, name: "支付成功", users: 10 },
        ],
      }),
      breakdownDimension: null,
    });
    expect(result.steps[1].stepRate).toBeCloseTo(0.4);
    expect(result.steps[2].stepRate).toBeCloseTo(0.5);
    expect(result.steps[3].stepRate).toBeCloseTo(0.5);
    expect(result.steps[1].dropped).toBe(60);
    expect(result.steps[2].dropped).toBe(20);
    expect(result.steps[3].dropped).toBe(10);
    expect(result.overallRate).toBeCloseTo(0.1);
  });

  it("采样元数据透传为 dataQuality", () => {
    const response: GaFunnelReportResponse = {
      funnelTable: {
        dimensionHeaders: [{ name: "funnelStepName" }],
        metricHeaders: [
          { name: "activeUsers", type: "TYPE_INTEGER" },
          { name: "funnelStepCompletionRate", type: "TYPE_INTEGER" },
          { name: "funnelStepAbandonments", type: "TYPE_INTEGER" },
          { name: "funnelStepAbandonmentRate", type: "TYPE_INTEGER" },
        ],
        rows: [
          {
            dimensionValues: [{ value: "1. 发起 Google 登录" }],
            metricValues: [{ value: "500" }, { value: "1" }, { value: "0" }, { value: "0" }],
          },
        ],
        metadata: {
          samplingMetadatas: [{ samplesReadCount: "12345", samplingSpaceSize: "100000" }],
        },
      },
    };
    const result = normalizeFunnelResponse({
      ...BASE_INPUT,
      spec: LOGIN_FUNNEL,
      response,
      breakdownDimension: null,
    });
    expect(result.dataQuality.sampled).toBe(true);
    expect(result.dataQuality.samplingNote).toContain("12.3%");
  });
});

describe("漏斗定义", () => {
  it("登录漏斗：第二步 30 分钟窗口", () => {
    expect(LOGIN_FUNNEL.steps).toHaveLength(2);
    expect(LOGIN_FUNNEL.steps[1].withinSecondsFromPriorStep).toBe(30 * 60);
    expect(LOGIN_FUNNEL.steps[0].withinSecondsFromPriorStep).toBeUndefined();
  });

  it("购买漏斗：第一步三参数过滤、窗口为 7d/30m/7d", () => {
    expect(PURCHASE_FUNNEL.steps).toHaveLength(4);
    expect(PURCHASE_FUNNEL.steps[0].paramFilter).toEqual([
      { parameter: "checkout_eligible", value: "true" },
      { parameter: "checkout_mode", value: "public" },
      { parameter: "payment_environment", value: "live" },
    ]);
    expect(PURCHASE_FUNNEL.steps[1].withinSecondsFromPriorStep).toBe(7 * 24 * 60 * 60);
    expect(PURCHASE_FUNNEL.steps[2].withinSecondsFromPriorStep).toBe(30 * 60);
    expect(PURCHASE_FUNNEL.steps[3].withinSecondsFromPriorStep).toBe(7 * 24 * 60 * 60);
    // 正式漏斗不含 test_* 事件
    expect(PURCHASE_FUNNEL.steps.some((s) => s.eventName.startsWith("test_"))).toBe(false);
  });
});
