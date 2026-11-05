/**
 * 全局共享类型：站点配置、GA4 查询结果、聚合后的统计数据。
 * 纯类型模块，前后端共用，不引入任何运行时依赖。
 */

/** 单个站点配置（config/sites.json 种子与 KV 存储共用此结构） */
export interface SiteConfig {
  /** 短标识，仅小写字母/数字/连字符，用于 URL 路由与 KV 主键 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 站点地址，如 https://example.com */
  url: string;
  /** GA4 Property ID（纯数字，不含 properties/ 前缀） */
  propertyId: string;
  /** 报告时区（IANA 名称，需与 GA4 Property 的报告时区一致；缺省 Asia/Shanghai） */
  timeZone?: string;
  /** 备注（可选） */
  note?: string;
  /**
   * 是否启用转化漏斗（可选）。漏斗依赖站点自有的事件埋点
   * （login_start / view_item / checkout_click 等），只有配置了该标记的站点
   * 才展示漏斗入口并允许查询 /api/sites/[id]/funnel。
   */
  funnel?: boolean;
}

/** 站点配置集合（KV 中存储的整体对象） */
export interface SitesConfig {
  version: 1;
  /** 异常判定阈值：变化幅度绝对值 ≥ 该值时标记异常（0.3 = 30%） */
  anomalyThreshold: number;
  sites: SiteConfig[];
}

/** 配置来源 */
export type SitesSource = "kv" | "file";

/** 加载后的站点配置（附带来源与诊断信息） */
export interface LoadedSitesConfig {
  config: SitesConfig;
  source: SitesSource;
  /** 是否绑定了 SITES_KV（决定管理界面能否写入） */
  kvAvailable: boolean;
  /** KV 数据存在但校验失败时给出提示（自动回退种子文件） */
  kvWarning?: string;
}

/** 统一的业务错误（每个站点独立携带，互不影响） */
export interface ApiError {
  /** 稳定错误码：UNCONFIGURED / AUTH / PERMISSION / NOT_FOUND / QUOTA / REQUEST / UNKNOWN */
  code: string;
  /** 面向用户的中文信息 */
  message: string;
}

/** 基础流量指标集 */
export interface MetricSet {
  /** UV（totalUsers） */
  users: number;
  /** PV（screenPageViews） */
  pageviews: number;
  /** 会话数（sessions） */
  sessions: number;
}

/** 单日数据点（daily 数组按时间升序） */
export interface DailyPoint extends MetricSet {
  /** 站点时区下的日期，YYYY-MM-DD */
  date: string;
}

/** 单小时数据点（hourly 数组按时间升序） */
export interface HourlyPoint extends MetricSet {
  /** 站点时区下的日期，YYYY-MM-DD */
  date: string;
  /** 0-23 小时 */
  hour: number;
}

/** 一个统计周期（今日/昨日/近7天/近30天）的指标与环比 */
export interface HistoryPeriod extends MetricSet {
  /** 上一等长周期的指标 */
  prev: MetricSet;
  /** UV 环比变化率，-1 表示 -100%；上一周期无数据时为 null */
  usersChangePct: number | null;
  /** PV 环比变化率 */
  pageviewsChangePct: number | null;
}

/** 异常标记 */
export interface Anomaly {
  direction: "up" | "down";
  /** 变化率（0.42 = +42%） */
  changePct: number;
  /** 判定依据 */
  basis: "today_same_time" | "last7" | "last30";
}

/** 单站点历史统计（/api/history 的每个元素） */
export interface SiteHistory {
  siteId: string;
  today: HistoryPeriod;
  yesterday: HistoryPeriod;
  last7: HistoryPeriod;
  last30: HistoryPeriod;
  /** 近 30 天每日数据（含今天，升序；缺失日期补零） */
  daily: DailyPoint[];
  /** 昨日 + 今日逐小时数据（升序；缺失小时补零） */
  hourly: HourlyPoint[];
  /** 今日 0 点至今的累计 */
  sameTimeToday: MetricSet;
  /** 昨日同时段累计（0 点至与今天相同的钟点） */
  sameTimeYesterday: MetricSet;
  anomaly?: Anomaly;
  error?: ApiError;
  fetchedAt: string;
}

/** 实时分钟趋势点（minutesAgo：29 = 约 29 分钟前，0 = 当前分钟） */
export interface RealtimePoint {
  minutesAgo: number;
  activeUsers: number;
  pageviews: number;
}

/** 单站点实时数据（/api/realtime 的每个元素） */
export interface SiteRealtime {
  siteId: string;
  /** 过去 30 分钟活跃用户数 */
  activeUsers: number;
  /** 过去 30 分钟 PV */
  pageviews: number;
  /** 分钟级趋势（升序：29 分钟前 → 当前） */
  trend: RealtimePoint[];
  error?: ApiError;
  fetchedAt: string;
}

/** 详情页单维度的行 */
export interface BreakdownRow {
  /** 维度值（如国家名、desktop、/path） */
  key: string;
  /** 附加标签（页面标题等，可为空） */
  label?: string;
  users: number;
  pageviews: number;
}

/** 支持的时间范围 */
export type RangeKey = "today" | "yesterday" | "7d" | "30d";

/** 单站点详情（/api/sites/[id]/detail） */
export interface SiteDetail {
  siteId: string;
  range: RangeKey;
  /** 范围内合计 */
  totals: MetricSet;
  /** 范围内逐日数据（today/yesterday 为单点） */
  daily: DailyPoint[];
  countries: BreakdownRow[];
  devices: BreakdownRow[];
  pages: BreakdownRow[];
  /** 流量来源：默认渠道分组 + 来源/媒介 */
  sources: BreakdownRow[];
  error?: ApiError;
  fetchedAt: string;
}

/** /api/realtime 响应 */
export interface RealtimeResponse {
  fetchedAt: string;
  /** 服务账号凭据是否已配置（未配置时提示去部署文档） */
  credentialsConfigured: boolean;
  /** 凭据未配置/非法时的具体提示 */
  credentialsError?: string;
  sites: SiteRealtime[];
  /** 全部站点实时合计 */
  totals: { activeUsers: number; pageviews: number };
}

/** /api/history 响应 */
export interface HistoryResponse {
  fetchedAt: string;
  anomalyThreshold: number;
  sites: SiteHistory[];
  /** 全部站点各周期合计（仅含成功站点） */
  totals: Record<"today" | "yesterday" | "last7" | "last30", MetricSet>;
}

/** /api/sites 响应 */
export interface SitesResponse {
  source: SitesSource;
  kvAvailable: boolean;
  kvWarning?: string;
  anomalyThreshold: number;
  sites: SiteConfig[];
}

/** /api/health 响应 */
export interface HealthResponse {
  ok: boolean;
  credentialsConfigured: boolean;
  credentialsError?: string;
  passwordProtected: boolean;
  kvAvailable: boolean;
  kvWarning?: string;
  siteCount: number;
  source: SitesSource;
}
