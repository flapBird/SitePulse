/**
 * 用户步骤转化漏斗：漏斗定义、GA4 v1alpha 请求构造、响应归一化。
 *
 * 漏斗定义保存在本监控项目内（不依赖 GA4 网页端的「探索」配置），
 * 通过 runFunnelReport 请求传入。归一化层处理 v1alpha 的实测怪癖：
 * - metricHeaders 重复两遍（8 个头 vs 4 个行值）→ 按 header 名称对齐去重
 * - 0 用户的步骤整行省略 → 按步骤序号补零
 * - 拆分维度含 RESERVED_TOTAL 总计行 → 与分组行分开，避免重复累加
 * 纯函数模块，便于单元测试。
 */

import {
  Ga4ApiError,
  runFunnelReport,
  type GaFunnelReportResponse,
  type GaFunnelStep,
  type GaRunFunnelReportRequest,
  type ServiceAccountCredentials,
} from "./ga4";
import { zonedDate } from "./datetime";
import type { ApiError } from "./types";
import type { SiteConfig } from "./types";

// ---------------------------------------------------------------------------
// 漏斗定义（监控平台侧保存，随请求传给 GA4）
// ---------------------------------------------------------------------------

/** 漏斗步骤的业务描述（含展示所需的元信息） */
export interface FunnelStepSpec {
  /** 展示名 */
  label: string;
  /** 事件名 */
  eventName: string;
  /** 事件参数过滤（原始参数名 + 精确匹配值） */
  paramFilter?: { parameter: string; value: string }[];
  /** 距上一步的时间窗口（秒） */
  withinSecondsFromPriorStep?: number;
}

export interface FunnelSpec {
  /** 稳定 id（URL 参数用） */
  id: string;
  /** 展示名 */
  title: string;
  /** 口径说明（页面上展示） */
  description: string;
  steps: FunnelStepSpec[];
  /** 是否排除 internal 用户（用户级排除细分） */
  excludeInternal: boolean;
}

/** 登录漏斗第二步必须在第一步后 30 分钟内完成 */
export const LOGIN_STEP_WINDOW_SECONDS = 30 * 60;
/** 购买漏斗：查看套餐 → 点击购买 7 天 */
export const PURCHASE_VIEW_TO_CLICK_SECONDS = 7 * 24 * 60 * 60;
/** 购买漏斗：点击购买 → 创建结账 30 分钟 */
export const PURCHASE_CLICK_TO_CHECKOUT_SECONDS = 30 * 60;
/** 购买漏斗：创建结账 → 支付成功 7 天 */
export const PURCHASE_CHECKOUT_TO_PURCHASE_SECONDS = 7 * 24 * 60 * 60;

/**
 * 网站埋点中携带 audience_type 参数的事件清单。
 * 用于用户级排除 internal：v1alpha 的 segment eventName 不支持 "*" 通配
 * （实测静默失效），必须枚举真实事件名。
 * page_view / ai_font_view 不携带 audience_type，无需列入。
 */
const EVENTS_WITH_AUDIENCE_TYPE = [
  "login_start",
  "login",
  "login_return",
  "view_item",
  "checkout_click",
  "checkout_error",
  "begin_checkout",
  "purchase",
  "test_begin_checkout",
  "test_purchase",
];

/** 内置漏斗：登录完成率 */
export const LOGIN_FUNNEL: FunnelSpec = {
  id: "login",
  title: "登录漏斗",
  description: "发起 Google 登录 → 30 分钟内登录成功。封闭漏斗：完成第二步的用户必然先经过第一步。",
  steps: [
    { label: "发起 Google 登录", eventName: "login_start" },
    { label: "登录成功", eventName: "login", withinSecondsFromPriorStep: LOGIN_STEP_WINDOW_SECONDS },
  ],
  excludeInternal: true,
};

/** 内置漏斗：正式购买转化（仅 live + public 流量；test_* 事件不混入） */
export const PURCHASE_FUNNEL: FunnelSpec = {
  id: "purchase",
  title: "购买漏斗",
  description:
    "查看套餐（checkout_eligible=true 且 checkout_mode=public 且 payment_environment=live）→ 7 天内点击购买 → 30 分钟内创建结账 → 7 天内支付成功。" +
    "相邻步骤窗口；老用户无需重新经过登录。测试事件（test_begin_checkout / test_purchase）不在正式漏斗事件内，不会计入。",
  steps: [
    {
      label: "查看套餐",
      eventName: "view_item",
      paramFilter: [
        { parameter: "checkout_eligible", value: "true" },
        { parameter: "checkout_mode", value: "public" },
        { parameter: "payment_environment", value: "live" },
      ],
    },
    { label: "点击购买", eventName: "checkout_click", withinSecondsFromPriorStep: PURCHASE_VIEW_TO_CLICK_SECONDS },
    { label: "创建结账", eventName: "begin_checkout", withinSecondsFromPriorStep: PURCHASE_CLICK_TO_CHECKOUT_SECONDS },
    { label: "支付成功", eventName: "purchase", withinSecondsFromPriorStep: PURCHASE_CHECKOUT_TO_PURCHASE_SECONDS },
  ],
  excludeInternal: true,
};

export const BUILTIN_FUNNELS: FunnelSpec[] = [LOGIN_FUNNEL, PURCHASE_FUNNEL];

export function findFunnel(id: string): FunnelSpec | undefined {
  return BUILTIN_FUNNELS.find((f) => f.id === id);
}

// ---------------------------------------------------------------------------
// 归一化后的业务类型（前端直接消费）
// ---------------------------------------------------------------------------

/** 单个步骤的漏斗内同口径统计 */
export interface FunnelStepResult {
  /** 步骤序号（1 起） */
  step: number;
  label: string;
  /** 到达该步骤的去重用户数 */
  users: number;
  /** 上一步 → 当前步转化率（小数；第一步或分母为 0 时 null） */
  stepRate: number | null;
  /** 上一步 → 当前步流失人数 */
  dropped: number;
  /** 上一步 → 当前步流失率（1 - stepRate；不可计算时 null） */
  dropRate: number | null;
  /** 步骤口径说明（事件 + 参数 + 窗口） */
  criteria: string;
}

/** 拆分维度下的一个分组（如 deviceCategory=mobile） */
export interface FunnelBreakdownGroup {
  /** 维度值（RESERVED_TOTAL 总计行单独放 overall，不混入分组） */
  key: string;
  /** 显示名（deviceCategory 等原始值直接可读） */
  label: string;
  steps: FunnelStepResult[];
  /** 首步到末步总体转化率（小数；分母为 0 时 null） */
  overallRate: number | null;
}

export interface FunnelDataQuality {
  /** 是否采样（v1alpha samplingMetadatas 存在时为 true） */
  sampled: boolean;
  /** 采样比例说明（如 "12.3%"），未采样时 undefined */
  samplingNote?: string;
}

export interface FunnelResult {
  siteId: string;
  funnelId: string;
  /** 日期范围（站点时区） */
  startDate: string;
  endDate: string;
  /** 是否含当天（当天数据为暂定） */
  includesToday: boolean;
  /** 总体（无拆分）的步骤序列 */
  steps: FunnelStepResult[];
  /** 首步到末步总体转化率（小数） */
  overallRate: number | null;
  /** 拆分维度（本次请求的 breakdownDimension，未拆分时 null） */
  breakdownDimension: string | null;
  /** 拆分分组（不含总计行） */
  breakdowns: FunnelBreakdownGroup[];
  dataQuality: FunnelDataQuality;
  /** 漏斗规则说明（来自 FunnelSpec） */
  funnelDescription: string;
  /** 排除口径说明 */
  exclusionNote: string;
  error?: ApiError;
  fetchedAt: string;
}

// ---------------------------------------------------------------------------
// 响应归一化
// ---------------------------------------------------------------------------

/** 从（可能重复的）metricHeaders 中按名称取值的索引映射 */
function metricIndexByName(subReport: { metricHeaders?: { name: string }[] }): Map<string, number> {
  const map = new Map<string, number>();
  (subReport.metricHeaders ?? []).forEach((h, index) => {
    if (!map.has(h.name)) map.set(h.name, index);
  });
  return map;
}

/** 从维度头中找拆分维度所在的下标（funnelStepName 恒为 0，segment 其后，拆分最后） */
function dimensionIndexByName(subReport: { dimensionHeaders?: { name: string }[] }, name: string): number {
  return (subReport.dimensionHeaders ?? []).findIndex((h) => h.name === name);
}

/** 步骤行的 funnelStepName 形如 "2. 登录成功" → 2 */
function stepIndexFromName(value: string): number | null {
  const match = /^(\d+)\./.exec(value);
  return match ? Number(match[1]) : null;
}

function toNumber(value: string | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** 步骤口径说明文本 */
function stepCriteria(spec: FunnelStepSpec): string {
  const parts: string[] = [spec.eventName];
  if (spec.paramFilter) {
    parts.push(spec.paramFilter.map((p) => `${p.parameter}=${p.value}`).join(" 且 "));
  }
  if (spec.withinSecondsFromPriorStep != null) {
    parts.push(`距上一步 ≤ ${formatWindow(spec.withinSecondsFromPriorStep)}`);
  }
  return parts.join(" · ");
}

/** 秒 → "30 分钟" / "7 天" */
export function formatWindow(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} 天`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} 小时`;
  return `${Math.round(seconds / 60)} 分钟`;
}

/** 由每步人数推导相邻步骤转化率/流失（漏斗内同一口径） */
function deriveStepMetrics(
  specs: FunnelStepSpec[],
  usersByStep: Map<number, number>,
): FunnelStepResult[] {
  const steps: FunnelStepResult[] = [];
  for (let i = 0; i < specs.length; i += 1) {
    const stepNo = i + 1;
    const users = usersByStep.get(stepNo) ?? 0;
    const prevUsers = i === 0 ? null : usersByStep.get(stepNo - 1) ?? 0;
    let stepRate: number | null = null;
    let dropped = 0;
    let dropRate: number | null = null;
    if (i > 0 && prevUsers != null && prevUsers > 0) {
      stepRate = users / prevUsers;
      dropped = Math.max(0, prevUsers - users);
      dropRate = 1 - stepRate;
    } else if (i > 0 && prevUsers === 0) {
      // 上一步 0 人：人数可展示，比率不可计算
      dropped = 0;
      dropRate = null;
    }
    steps.push({
      step: stepNo,
      label: specs[i].label,
      users,
      stepRate,
      dropped,
      dropRate,
      criteria: stepCriteria(specs[i]),
    });
  }
  return steps;
}

function overallRateOf(steps: FunnelStepResult[]): number | null {
  const first = steps[0];
  const last = steps[steps.length - 1];
  if (!first || !last || first.users <= 0) return null;
  return last.users / first.users;
}

/** 解析 v1alpha funnelTable → FunnelResult（纯函数，测试友好） */
export function normalizeFunnelResponse(input: {
  spec: FunnelSpec;
  response: GaFunnelReportResponse;
  siteId: string;
  startDate: string;
  endDate: string;
  includesToday: boolean;
  breakdownDimension: string | null;
  now?: Date;
}): FunnelResult {
  const table = input.response.funnelTable;
  const now = input.now ?? new Date();

  const empty: FunnelResult = {
    siteId: input.siteId,
    funnelId: input.spec.id,
    startDate: input.startDate,
    endDate: input.endDate,
    includesToday: input.includesToday,
    steps: deriveStepMetrics(input.spec.steps, new Map()),
    overallRate: null,
    breakdownDimension: input.breakdownDimension,
    breakdowns: [],
    dataQuality: { sampled: false },
    funnelDescription: input.spec.description,
    exclusionNote: exclusionNoteOf(input.spec),
    fetchedAt: now.toISOString(),
  };
  if (!table) return empty;

  const metricIndex = metricIndexByName(table);
  const usersIdx = metricIndex.get("activeUsers");
  if (usersIdx == null) return empty;

  // 拆分维度下标（funnelStepName / segment / breakdown）
  const breakdownIdx = input.breakdownDimension
    ? dimensionIndexByName(table, input.breakdownDimension)
    : -1;

  // key = 拆分维度值（无拆分时固定 ""）；组内按步骤号存人数
  const groups = new Map<string, Map<number, number>>();
  for (const row of table.rows ?? []) {
    const dims = row.dimensionValues ?? [];
    const stepNo = stepIndexFromName(dims[0]?.value ?? "");
    if (stepNo == null) continue;
    const groupKey =
      breakdownIdx >= 0 ? dims[breakdownIdx]?.value ?? "(unknown)" : "";
    const values = row.metricValues ?? [];
    const users = toNumber(values[usersIdx]?.value);
    let byStep = groups.get(groupKey);
    if (!byStep) {
      byStep = new Map();
      groups.set(groupKey, byStep);
    }
    byStep.set(stepNo, users);
  }

  const buildGroup = (key: string, label: string): FunnelBreakdownGroup => {
    const steps = deriveStepMetrics(input.spec.steps, groups.get(key) ?? new Map());
    return { key, label, steps, overallRate: overallRateOf(steps) };
  };

  let steps: FunnelStepResult[];
  let breakdowns: FunnelBreakdownGroup[];
  if (input.breakdownDimension && breakdownIdx >= 0) {
    // RESERVED_TOTAL 是总计行，单独作为 overall；其余为分组
    const totalGroup = groups.get("RESERVED_TOTAL");
    steps = deriveStepMetrics(input.spec.steps, totalGroup ?? new Map());
    breakdowns = [...groups.keys()]
      .filter((k) => k !== "RESERVED_TOTAL")
      .sort((a, b) => (groups.get(b)?.get(1) ?? 0) - (groups.get(a)?.get(1) ?? 0))
      .map((k) => buildGroup(k, k));
  } else {
    steps = deriveStepMetrics(input.spec.steps, groups.get("") ?? new Map());
    breakdowns = [];
  }

  // 采样元数据（未采样时字段不出现）
  const sampling = table.metadata?.samplingMetadatas ?? [];
  let dataQuality: FunnelDataQuality = { sampled: false };
  if (sampling.length > 0) {
    const notes = sampling
      .map((s) => {
        const read = Number(s.samplesReadCount ?? 0);
        const total = Number(s.samplingSpaceSize ?? 0);
        return total > 0 ? `${((read / total) * 100).toFixed(1)}%` : null;
      })
      .filter((n): n is string => n != null);
    dataQuality = {
      sampled: true,
      samplingNote: notes.length > 0 ? `本报表基于采样数据（覆盖率 ${notes.join("、")}）` : "本报表基于采样数据",
    };
  }

  return {
    siteId: input.siteId,
    funnelId: input.spec.id,
    startDate: input.startDate,
    endDate: input.endDate,
    includesToday: input.includesToday,
    steps,
    overallRate: overallRateOf(steps),
    breakdownDimension: input.breakdownDimension,
    breakdowns,
    dataQuality,
    funnelDescription: input.spec.description,
    exclusionNote: exclusionNoteOf(input.spec),
    fetchedAt: now.toISOString(),
  };
}

/** 排除口径说明（含实现限制） */
function exclusionNoteOf(spec: FunnelSpec): string {
  if (!spec.excludeInternal) return "未配置用户排除。";
  return (
    "已按用户级排除细分剔除分析期间出现过 audience_type=internal 的用户（USER_EXCLUSION_PERMANENT）。" +
    "限制：排除条件枚举了携带 audience_type 的埋点事件清单，依赖这些事件上报该参数；" +
    "page_view 等不带 audience_type 的事件无法用于识别内部用户。"
  );
}

// ---------------------------------------------------------------------------
// 站点级查询（与 lib/queries.ts 的模式一致：总是成功，错误挂在 error 上）
// ---------------------------------------------------------------------------

/** 漏斗支持的日期范围（天） */
export const FUNNEL_RANGES: Record<string, number> = {
  "7d": 7,
  "14d": 14,
  "28d": 28,
  "90d": 90,
};

export const DEFAULT_FUNNEL_RANGE = "28d";

export const FUNNEL_RANGE_LABELS: Record<string, string> = {
  "7d": "近 7 天",
  "14d": "近 14 天",
  "28d": "近 28 天",
  "90d": "近 90 天",
};

/** 漏斗支持的事件可用性探测也走这里（供诊断） */
const PROBE_EVENTS = [
  "login_start",
  "login",
  "view_item",
  "checkout_click",
  "checkout_error",
  "begin_checkout",
  "purchase",
  "test_begin_checkout",
  "test_purchase",
];

/** 埋点采集链路诊断（近 28 天各事件的用户数与次数） */
export interface EventProbeRow {
  eventName: string;
  users: number;
  count: number;
  /** 是否属于某个内置漏斗的步骤事件 */
  inFunnel: boolean;
}

function timeZoneOf(site: SiteConfig): string {
  return site.timeZone?.trim() || "Asia/Shanghai";
}

/**
 * 查询单站点漏斗。失败时返回带 error 的空结构（同 queries.ts 惯例）。
 */
export async function fetchSiteFunnel(
  cred: ServiceAccountCredentials,
  site: SiteConfig,
  spec: FunnelSpec,
  rangeKey: string,
  breakdownDimension: string | null,
  now: Date = new Date(),
): Promise<FunnelResult> {
  const tz = timeZoneOf(site);
  const days = FUNNEL_RANGES[rangeKey] ?? FUNNEL_RANGES[DEFAULT_FUNNEL_RANGE];
  const startDate = zonedDate(-(days - 1), tz, now);
  const endDate = zonedDate(0, tz, now);
  const today = zonedDate(0, tz, now);
  const includesToday = endDate === today;

  try {
    const steps: GaFunnelStep[] = spec.steps.map((s) => ({
      name: s.label,
      eventName: s.eventName,
      paramFilter: s.paramFilter,
      withinSecondsFromPriorStep: s.withinSecondsFromPriorStep,
    }));
    const request: GaRunFunnelReportRequest = {
      dateRanges: [{ startDate, endDate }],
      funnel: { isOpenFunnel: false, steps },
      breakdownDimension: breakdownDimension ?? undefined,
      excludeSegment: spec.excludeInternal
        ? { eventNames: EVENTS_WITH_AUDIENCE_TYPE, parameter: "audience_type", value: "internal" }
        : undefined,
    };
    const response = await runFunnelReport(cred, site.propertyId, request);
    return normalizeFunnelResponse({
      spec,
      response,
      siteId: site.id,
      startDate,
      endDate,
      includesToday,
      breakdownDimension,
      now,
    });
  } catch (err) {
    const base = normalizeFunnelResponse({
      spec,
      response: {},
      siteId: site.id,
      startDate,
      endDate,
      includesToday,
      breakdownDimension,
      now,
    });
    base.error = toApiError(err);
    return base;
  }
}

function toApiError(err: unknown): ApiError {
  // 与 lib/queries.ts 的 toApiError 逻辑一致
  if (err instanceof Ga4ApiError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { code: "UNKNOWN", message: `查询失败：${err.message}` };
  }
  return { code: "UNKNOWN", message: "查询失败：未知错误" };
}
