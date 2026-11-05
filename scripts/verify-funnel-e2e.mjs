#!/usr/bin/env node
/**
 * 漏斗集成验证：模拟 app/api/sites/[id]/funnel 的完整链路。
 *
 * dev 环境的 workerd 不读系统代理（无法直连 Google），因此这里在 Node 侧
 * 复刻路由的请求构造（lib/funnel.ts 的 fetchSiteFunnel 生成的 JSON 与本
 * 脚本逐字段一致），调用真实 v1alpha API 后用相同的归一化规则校验数字。
 *
 * 用法：NODE_USE_ENV_PROXY=1 HTTPS_PROXY=… node scripts/verify-funnel-e2e.mjs <key.json> <propertyId>
 */

import { readFileSync } from "node:fs";
import crypto from "node:crypto";

const [keyPath, propertyId] = process.argv.slice(2);
if (!keyPath || !propertyId) {
  console.error("用法：node scripts/verify-funnel-e2e.mjs <service-account-key.json> <propertyId>");
  process.exit(1);
}

const key = JSON.parse(readFileSync(keyPath, "utf8"));
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ALPHA = "https://analyticsdata.googleapis.com/v1alpha";

const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const payload = Buffer.from(
  JSON.stringify({ iss: key.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly", aud: TOKEN_URL, iat: now, exp: now + 3600 }),
).toString("base64url");
const signer = crypto.createSign("RSA-SHA256");
signer.update(`${header}.${payload}`);
const signature = signer.sign(key.private_key).toString("base64url");
const tokenRes = await fetch(TOKEN_URL, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${payload}.${signature}` }),
});
if (!tokenRes.ok) {
  console.error("❌ token 失败", tokenRes.status);
  process.exit(1);
}
const { access_token: token } = await tokenRes.json();

// ---- 与 lib/funnel.ts 完全一致的请求构造（28 天，站点时区 Asia/Shanghai）----
function zonedDate(offsetDays, tz = "Asia/Shanghai", date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const utc = Date.UTC(get("year"), get("month") - 1, get("day")) + offsetDays * 86400000;
  const d = new Date(utc);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const EVENTS_WITH_AUDIENCE_TYPE = ["login_start","login","login_return","view_item","checkout_click","checkout_error","begin_checkout","purchase","test_begin_checkout","test_purchase"];

function funnelStep(s) {
  const step = {
    name: s.label,
    filterExpression: {
      funnelEventFilter: {
        eventName: s.eventName,
        ...(s.paramFilter?.length ? { funnelParameterFilterExpression: { andGroup: { expressions: s.paramFilter.map((p) => ({ funnelParameterFilter: { eventParameterName: p.parameter, stringFilter: { matchType: "EXACT", value: p.value } } })) } } } : {}),
      },
    },
  };
  if (s.withinSecondsFromPriorStep != null) {
    step.isDirectlyFollowedBy = false;
    step.withinDurationFromPriorStep = `${s.withinSecondsFromPriorStep}s`;
  }
  return step;
}

function excludeSegment() {
  return {
    name: "排除内部账号",
    userSegment: {
      exclusion: {
        userExclusionDuration: "USER_EXCLUSION_PERMANENT",
        userExclusionCriteria: {
          andConditionGroups: [{
            conditionScoping: "USER_CRITERIA_ACROSS_ALL_SESSIONS",
            segmentFilterExpression: {
              orGroup: {
                expressions: EVENTS_WITH_AUDIENCE_TYPE.map((eventName) => ({
                  segmentEventFilter: {
                    eventName,
                    segmentParameterFilterExpression: { orGroup: { expressions: [{ segmentParameterFilter: { eventParameterName: "audience_type", stringFilter: { matchType: "EXACT", value: "internal" } } }] } },
                  },
                })),
              },
            },
          }],
        },
      },
    },
  };
}

const LOGIN_FUNNEL = {
  steps: [
    { label: "发起 Google 登录", eventName: "login_start" },
    { label: "登录成功", eventName: "login", withinSecondsFromPriorStep: 1800 },
  ],
};
const PURCHASE_FUNNEL = {
  steps: [
    { label: "查看套餐", eventName: "view_item", paramFilter: [
      { parameter: "checkout_eligible", value: "true" },
      { parameter: "checkout_mode", value: "public" },
      { parameter: "payment_environment", value: "live" },
    ] },
    { label: "点击购买", eventName: "checkout_click", withinSecondsFromPriorStep: 604800 },
    { label: "创建结账", eventName: "begin_checkout", withinSecondsFromPriorStep: 1800 },
    { label: "支付成功", eventName: "purchase", withinSecondsFromPriorStep: 604800 },
  ],
};

async function runFunnel(label, spec, breakdownDimension) {
  const body = {
    dateRanges: [{ startDate: zonedDate(-27), endDate: zonedDate(0) }],
    funnel: { isOpenFunnel: false, steps: spec.steps.map(funnelStep) },
    segments: [excludeSegment()],
  };
  if (breakdownDimension) body.funnelBreakdown = { breakdownDimension: { name: breakdownDimension }, limit: "15" };

  const res = await fetch(`${ALPHA}/properties/${propertyId}:runFunnelReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    console.log(`❌ ${label}（HTTP ${res.status}）：${text.slice(0, 300)}`);
    return;
  }
  const data = JSON.parse(text);
  const table = data.funnelTable ?? {};

  // ---- 与 lib/funnel.ts normalizeFunnelResponse 相同的解析规则 ----
  const metricIdx = new Map();
  (table.metricHeaders ?? []).forEach((h, i) => { if (!metricIdx.has(h.name)) metricIdx.set(h.name, i); });
  const usersIdx = metricIdx.get("activeUsers");
  const dimHeaders = (table.dimensionHeaders ?? []).map((h) => h.name);
  const breakdownIdx = breakdownDimension ? dimHeaders.indexOf(breakdownDimension) : -1;

  const groups = new Map();
  for (const row of table.rows ?? []) {
    const m = /^(\d+)\./.exec(row.dimensionValues?.[0]?.value ?? "");
    if (!m) continue;
    const stepNo = Number(m[1]);
    const gk = breakdownIdx >= 0 ? row.dimensionValues[breakdownIdx]?.value ?? "?" : "";
    if (!groups.has(gk)) groups.set(gk, new Map());
    groups.get(gk).set(stepNo, Number(row.metricValues?.[usersIdx]?.value ?? 0));
  }

  const total = groups.get("RESERVED_TOTAL") ?? groups.get("") ?? new Map();
  const stepCount = spec.steps.length;
  console.log(`✅ ${label}`);
  let prev = null;
  for (let i = 1; i <= stepCount; i += 1) {
    const users = total.get(i) ?? 0;
    const rate = i > 1 && prev > 0 ? (users / prev).toFixed(4) : "—";
    const dropped = i > 1 && prev > 0 ? prev - users : "—";
    console.log(`   ${i}. ${spec.steps[i - 1].label}: ${users} 人  转化率=${rate}  流失=${dropped}`);
    prev = users;
  }
  const first = total.get(1) ?? 0;
  const last = total.get(stepCount) ?? 0;
  console.log(`   总体转化率 = ${last}/${first} = ${first > 0 ? (last / first).toFixed(4) : "—"}`);

  if (breakdownIdx >= 0) {
    for (const [gk, byStep] of [...groups.entries()].sort((a, b) => (b[1].get(1) ?? 0) - (a[1].get(1) ?? 0))) {
      if (gk === "RESERVED_TOTAL") continue;
      const nums = [];
      for (let i = 1; i <= stepCount; i += 1) nums.push(byStep.get(i) ?? 0);
      const gFirst = byStep.get(1) ?? 0;
      const gLast = byStep.get(stepCount) ?? 0;
      console.log(`   [${gk}] ${nums.join("→")}  总体=${gFirst > 0 ? (gLast / gFirst).toFixed(4) : "—"}`);
    }
  }
  const sampling = table.metadata?.samplingMetadatas;
  console.log(`   采样: ${sampling ? JSON.stringify(sampling) : "无"}\n`);
}

console.log(`日期范围：${zonedDate(-27)} ~ ${zonedDate(0)}（Asia/Shanghai，近 28 天）\n`);
await runFunnel("登录漏斗（整体）", LOGIN_FUNNEL, null);
await runFunnel("登录漏斗（按设备）", LOGIN_FUNNEL, "deviceCategory");
await runFunnel("购买漏斗（整体）", PURCHASE_FUNNEL, null);
await runFunnel("购买漏斗（按设备）", PURCHASE_FUNNEL, "deviceCategory");
