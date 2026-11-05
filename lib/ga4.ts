/**
 * GA4 Data API v1beta 轻量客户端。
 *
 * 不使用 @google-analytics/data SDK（其 Node 依赖链在 Cloudflare Workers 上不可靠），
 * 而是直接调用 REST 接口：WebCrypto 签发 RS256 JWT → 换取 OAuth2 access token
 * （scope 为 analytics.readonly，只读）→ POST runReport / batchRunReports /
 * runRealtimeReport。带超时、限流重试与错误归一化。
 *
 * 本模块保持纯净（不 import cloudflare:workers），便于单元测试。
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const API_BASE = "https://analyticsdata.googleapis.com/v1beta";

/** Service Account JSON 密钥中用到的字段 */
export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
  project_id?: string;
}

/** 归一化后的 GA4 API 错误 */
export class Ga4ApiError extends Error {
  /** 稳定错误码，见 mapApiError */
  code: string;
  /** HTTP 状态码（如有） */
  status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "Ga4ApiError";
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// 报表请求/响应类型（GA4 Data API 的最小子集）
// ---------------------------------------------------------------------------

export interface GaDateRange {
  startDate: string;
  endDate: string;
  name?: string;
}

export interface GaMinuteRange {
  name?: string;
  startMinutesAgo?: number;
  endMinutesAgo?: number;
}

export interface GaDimension {
  name: string;
}

export interface GaMetric {
  name: string;
}

export interface GaOrderBy {
  metric?: { metricName: string; desc?: boolean };
  dimension?: { dimensionName: string; desc?: boolean; orderType?: "DIMENSION_ORDER" | "ALPHANUMERIC" };
  desc?: boolean;
}

export interface GaRunReportRequest {
  dateRanges?: GaDateRange[];
  minuteRanges?: GaMinuteRange[];
  dimensions?: GaDimension[];
  metrics?: GaMetric[];
  orderBys?: GaOrderBy[];
  dimensionFilter?: unknown;
  metricFilter?: unknown;
  limit?: number;
  offset?: number;
  keepEmptyRows?: boolean;
}

export interface GaRow {
  dimensionValues?: { value: string }[];
  metricValues?: { value: string }[];
}

export interface GaRunReportResponse {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string; type: string }[];
  rows?: GaRow[];
  rowCount?: number;
  metadata?: { currencyCode?: string; dataLossFromOtherRow?: boolean };
}

export interface GaBatchRunReportsResponse {
  reports: GaRunReportResponse[];
}

// ---------------------------------------------------------------------------
// base64url / PEM 工具
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

function bytesToB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function jsonToB64Url(value: unknown): string {
  return bytesToB64Url(textEncoder.encode(JSON.stringify(value)));
}

/** 把 PEM（PKCS#8）私钥解码为 DER 字节 */
export function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replaceAll("-----BEGIN PRIVATE KEY-----", "")
    .replaceAll("-----END PRIVATE KEY-----", "")
    .replaceAll("-----BEGIN RSA PRIVATE KEY-----", "")
    .replaceAll("-----END RSA PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const buffer = new ArrayBuffer(bin.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 解析 Service Account JSON（来自 GA_SERVICE_ACCOUNT_JSON 环境变量） */
export function parseServiceAccount(json: string): ServiceAccountCredentials {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Ga4ApiError("CONFIG", "GA_SERVICE_ACCOUNT_JSON 不是合法的 JSON（应粘贴 Service Account 密钥文件内容）");
  }
  const obj = (raw ?? {}) as Record<string, unknown>;
  const clientEmail = typeof obj.client_email === "string" ? obj.client_email : "";
  const privateKey = typeof obj.private_key === "string" ? obj.private_key : "";
  if (!clientEmail || !privateKey) {
    throw new Ga4ApiError("CONFIG", "Service Account JSON 缺少 client_email 或 private_key 字段");
  }
  return {
    client_email: clientEmail,
    private_key: privateKey,
    project_id: typeof obj.project_id === "string" ? obj.project_id : undefined,
  };
}

/** 允许粘贴 properties/123456 或纯数字，统一成纯数字 ID */
export function normalizePropertyId(input: string): string {
  const id = input.trim().replace(/^properties\//, "");
  if (!/^\d{4,}$/.test(id)) {
    throw new Ga4ApiError("CONFIG", `GA4 Property ID 格式不正确：「${input}」应为纯数字（可含 properties/ 前缀）`);
  }
  return id;
}

// ---------------------------------------------------------------------------
// OAuth2：JWT bearer → access token（进程内缓存，避免每次请求都换 token）
// ---------------------------------------------------------------------------

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();
const pendingToken = new Map<string, Promise<string>>();

async function signJwt(cred: ServiceAccountCredentials, iat: number): Promise<string> {
  const header = jsonToB64Url({ alg: "RS256", typ: "JWT" });
  const payload = jsonToB64Url({
    iss: cred.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat,
    exp: iat + 3600,
  });
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(cred.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, textEncoder.encode(signingInput));
  return `${signingInput}.${bytesToB64Url(new Uint8Array(signature))}`;
}

/** 获取（并缓存）access token；同一凭据的并发请求会合并为一次换取 */
export async function getAccessToken(cred: ServiceAccountCredentials, now: number = Date.now()): Promise<string> {
  const cached = tokenCache.get(cred.client_email);
  if (cached && cached.expiresAt > now + 60_000) return cached.token;

  const pending = pendingToken.get(cred.client_email);
  if (pending) return pending;

  const task = (async () => {
    const assertion = await signJwt(cred, Math.floor(now / 1000));
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });
    let res: Response;
    try {
      res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new Ga4ApiError("REQUEST", `无法连接 Google OAuth 服务：${describeNetworkError(err)}`);
    }
    if (!res.ok) {
      // 400（invalid_grant 等）在令牌端点上同样代表密钥/签名问题
      const detail = await readGoogleError(res);
      const authFailed = res.status === 400 || res.status === 401 || res.status === 403;
      throw new Ga4ApiError(
        authFailed ? "AUTH" : "REQUEST",
        `换取 Google 访问令牌失败（HTTP ${res.status}）：${detail}`,
        res.status,
      );
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      throw new Ga4ApiError("AUTH", "Google OAuth 响应中缺少 access_token");
    }
    const ttlMs = Math.max(60, (data.expires_in ?? 3600) - 120) * 1000;
    tokenCache.set(cred.client_email, { token: data.access_token, expiresAt: now + ttlMs });
    return data.access_token;
  })();

  pendingToken.set(cred.client_email, task);
  try {
    return await task;
  } finally {
    pendingToken.delete(cred.client_email);
  }
}

// ---------------------------------------------------------------------------
// HTTP：超时 + 限流重试 + 错误归一化
// ---------------------------------------------------------------------------

function describeNetworkError(err: unknown): string {
  if (err instanceof DOMException && err.name === "TimeoutError") return "请求超时";
  if (err instanceof Error) return err.message;
  return String(err);
}

async function readGoogleError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: { message?: string; status?: string } };
    return data.error?.message ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

/** 把 GA4 的错误响应翻译成稳定错误码 + 中文信息（附 Google 原始信息便于定位） */
export function mapApiError(status: number, detail: string): Ga4ApiError {
  const raw = detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
  if (status === 401) {
    return new Ga4ApiError("AUTH", `Google 鉴权失败（401）：Service Account 密钥可能已失效。原始信息：${raw}`, status);
  }
  if (status === 403) {
    return new Ga4ApiError(
      "PERMISSION",
      `GA4 拒绝访问（403）：请确认已把服务账号加为该 Property 的查看者。Google 原始信息：${raw}`,
      status,
    );
  }
  if (status === 404) {
    return new Ga4ApiError("NOT_FOUND", `GA4 Property 不存在（404）：请检查站点配置中的 Property ID。${raw}`, status);
  }
  if (status === 400) {
    return new Ga4ApiError("NOT_FOUND", `GA4 请求无效（400）：请检查 Property ID 或稍后重试。${raw}`, status);
  }
  if (status === 429) {
    return new Ga4ApiError("QUOTA", `GA4 配额已用尽（429）：请稍后重试或减少站点数量。${raw}`, status);
  }
  if (status >= 500) {
    return new Ga4ApiError("REQUEST", `Google 服务暂时不可用（${status}）：${raw}`, status);
  }
  return new Ga4ApiError("REQUEST", `GA4 请求失败（HTTP ${status}）：${raw}`, status);
}

async function apiFetch(
  url: string,
  token: string,
  body: unknown,
  attempt = 0,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // 网络抖动/超时：限流式重试一次
    if (attempt === 0) {
      await sleep(500 + Math.random() * 500);
      return apiFetch(url, token, body, attempt + 1);
    }
    throw new Ga4ApiError("REQUEST", `请求 GA4 API 失败：${describeNetworkError(err)}`);
  }

  if (res.ok) {
    try {
      return await res.json();
    } catch {
      return {};
    }
  }

  const detail = await readGoogleError(res);
  // 429/5xx 视为临时故障，重试一次
  if ((res.status === 429 || res.status >= 500) && attempt === 0) {
    await sleep(600 + Math.random() * 600);
    return apiFetch(url, token, body, attempt + 1);
  }
  throw mapApiError(res.status, detail);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 报表 API
// ---------------------------------------------------------------------------

function propertyUrl(propertyId: string, method: string): string {
  return `${API_BASE}/properties/${encodeURIComponent(propertyId)}:${method}`;
}

async function postReport(
  cred: ServiceAccountCredentials,
  propertyId: string,
  method: "runReport" | "batchRunReports" | "runRealtimeReport",
  body: unknown,
): Promise<unknown> {
  const token = await getAccessToken(cred);
  return apiFetch(propertyUrl(propertyId, method), token, body);
}

/** 标准报表（历史统计） */
export async function runReport(
  cred: ServiceAccountCredentials,
  propertyId: string,
  request: GaRunReportRequest,
): Promise<GaRunReportResponse> {
  return (await postReport(cred, propertyId, "runReport", request)) as GaRunReportResponse;
}

/** 批量标准报表：一次 HTTP 携带多个子报表，节省配额与延迟（上限 5 个） */
export async function batchRunReports(
  cred: ServiceAccountCredentials,
  propertyId: string,
  requests: GaRunReportRequest[],
): Promise<GaBatchRunReportsResponse> {
  if (requests.length === 0) return { reports: [] };
  if (requests.length > 5) {
    throw new Ga4ApiError("REQUEST", `batchRunReports 一次最多 5 个子报表，收到 ${requests.length} 个`);
  }
  const res = (await postReport(cred, propertyId, "batchRunReports", {
    requests,
  })) as GaBatchRunReportsResponse;
  return { reports: res.reports ?? [] };
}

/** 实时报表（过去 30 分钟窗口） */
export async function runRealtimeReport(
  cred: ServiceAccountCredentials,
  propertyId: string,
  request: GaRunReportRequest,
): Promise<GaRunReportResponse> {
  return (await postReport(cred, propertyId, "runRealtimeReport", request)) as GaRunReportResponse;
}

// ---------------------------------------------------------------------------
// 漏斗报表（Data API v1alpha runFunnelReport）
// ---------------------------------------------------------------------------

/** 顺序漏斗的一步：事件 + 可选参数过滤 + 可选距上一步的时间窗口 */
export interface GaFunnelStep {
  /** 步骤名（决定返回的 funnelStepName 维度值，如 "1. 发起登录"） */
  name: string;
  /** 事件名；paramFilter 非空时只统计同时满足参数条件的事件 */
  eventName: string;
  /** 事件参数过滤（原始参数名，非 customEvent: 前缀维度） */
  paramFilter?: { parameter: string; value: string }[];
  /** 距上一步完成的时间窗口（秒）；第一步忽略 */
  withinSecondsFromPriorStep?: number;
}

/** runFunnelReport 请求结构（响应见 GaFunnelReportResponse） */
export interface GaRunFunnelReportRequest {
  dateRanges?: GaDateRange[];
  funnel: {
    /** 封闭漏斗（必须从第一步进入）。规范要求 false。 */
    isOpenFunnel: false;
    steps: GaFunnelStep[];
  };
  /** 拆分维度（如 deviceCategory）；country/sessionSourceMedium 待确认后加入 */
  breakdownDimension?: string;
  /** 用户级排除细分：命中所列事件 + 参数条件的用户整期排除 */
  excludeSegment?: {
    /** 携带目标参数的事件名清单（v1alpha 的 eventName 不支持 "*" 通配，
     *  必须枚举真实事件名，否则排除静默失效——已实测验证） */
    eventNames: string[];
    parameter: string;
    value: string;
  };
}

/**
 * v1alpha 返回结构的最小子集。注意两个实测怪癖：
 * - metricHeaders 会把 4 个指标重复两遍（8 个头），行内 metricValues 只有
 *   4 个值——解析必须按 header 名称对齐并去重，不能按下标硬编码。
 * - 0 用户的步骤整行省略，需按步骤序号补零。
 */
export interface GaFunnelSubReport {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string; type: string }[];
  rows?: GaRow[];
  metadata?: {
    samplingMetadatas?: { samplesReadCount?: string; samplingSpaceSize?: string }[];
  };
}

export interface GaFunnelReportResponse {
  funnelTable?: GaFunnelSubReport;
  funnelVisualization?: GaFunnelSubReport;
  propertyQuota?: unknown;
}

const ALPHA_API_BASE = "https://analyticsdata.googleapis.com/v1alpha";

/** 把内部步骤描述转成 v1alpha 的 FunnelStep JSON */
function toApiFunnelSteps(steps: GaFunnelStep[]): unknown[] {
  return steps.map((step) => {
    const apiStep: Record<string, unknown> = {
      name: step.name,
      filterExpression: {
        funnelEventFilter: {
          eventName: step.eventName,
          ...(step.paramFilter && step.paramFilter.length > 0
            ? {
                funnelParameterFilterExpression: {
                  andGroup: {
                    expressions: step.paramFilter.map((p) => ({
                      funnelParameterFilter: {
                        eventParameterName: p.parameter,
                        stringFilter: { matchType: "EXACT", value: p.value },
                      },
                    })),
                  },
                },
              }
            : {}),
        },
      },
    };
    if (step.withinSecondsFromPriorStep != null) {
      apiStep.isDirectlyFollowedBy = false;
      apiStep.withinDurationFromPriorStep = `${step.withinSecondsFromPriorStep}s`;
    }
    return apiStep;
  });
}

/** 构造用户级排除 segment（USER_EXCLUSION_PERMANENT：出现过即整期排除） */
function toApiExcludeSegment(
  exclude: NonNullable<GaRunFunnelReportRequest["excludeSegment"]>,
): unknown {
  return {
    name: "排除内部账号",
    userSegment: {
      exclusion: {
        userExclusionDuration: "USER_EXCLUSION_PERMANENT",
        userExclusionCriteria: {
          andConditionGroups: [
            {
              conditionScoping: "USER_CRITERIA_ACROSS_ALL_SESSIONS",
              segmentFilterExpression: {
                orGroup: {
                  expressions: exclude.eventNames.map((eventName) => ({
                    segmentEventFilter: {
                      eventName,
                      segmentParameterFilterExpression: {
                        orGroup: {
                          expressions: [
                            {
                              segmentParameterFilter: {
                                eventParameterName: exclude.parameter,
                                stringFilter: { matchType: "EXACT", value: exclude.value },
                              },
                            },
                          ],
                        },
                      },
                    },
                  })),
                },
              },
            },
          ],
        },
      },
    },
  };
}

/**
 * 顺序用户漏斗（v1alpha runFunnelReport）。封闭漏斗，步骤间允许出现其他
 * 事件（isDirectlyFollowedBy: false），时间窗口按相邻步骤计算。
 * 复用与 v1beta 相同的只读授权与超时/重试/错误归一化。
 */
export async function runFunnelReport(
  cred: ServiceAccountCredentials,
  propertyId: string,
  request: GaRunFunnelReportRequest,
): Promise<GaFunnelReportResponse> {
  const token = await getAccessToken(cred);
  const body: Record<string, unknown> = {
    dateRanges: request.dateRanges,
    funnel: {
      isOpenFunnel: false,
      steps: toApiFunnelSteps(request.funnel.steps),
    },
  };
  if (request.breakdownDimension) {
    body.funnelBreakdown = {
      breakdownDimension: { name: request.breakdownDimension },
      limit: "15",
    };
  }
  if (request.excludeSegment) {
    body.segments = [toApiExcludeSegment(request.excludeSegment)];
  }
  const url = `${ALPHA_API_BASE}/properties/${encodeURIComponent(propertyId)}:runFunnelReport`;
  return (await apiFetch(url, token, body)) as GaFunnelReportResponse;
}
