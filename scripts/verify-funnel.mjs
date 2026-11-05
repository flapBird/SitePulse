#!/usr/bin/env node
/**
 * 漏斗报表前置探测：验证 runFunnelReport 的能力面与真实数据可用性。
 *
 * 1. 服务账号对目标 Property 的访问权限（Admin API accountSummaries）
 * 2. 漏斗相关事件近 28 天的实际采集（runReport: eventName × totalUsers/eventCount）
 * 3. metadata API 中 customEvent:* 维度的真实 API 名称
 * 4. v1alpha runFunnelReport 的登录/购买漏斗与拆分维度（真实请求结构）
 *
 * 用法（需能直连 Google，本地代理环境加 NODE_USE_ENV_PROXY=1 HTTPS_PROXY=…）：
 *   node scripts/verify-funnel.mjs <service-account-key.json> <propertyId>
 */

import { readFileSync } from "node:fs";
import crypto from "node:crypto";

const [keyPath, propertyId] = process.argv.slice(2);
if (!keyPath || !propertyId) {
  console.error("用法：node scripts/verify-funnel.mjs <service-account-key.json> <propertyId>");
  process.exit(1);
}

const key = JSON.parse(readFileSync(keyPath, "utf8"));
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ALPHA_BASE = "https://analyticsdata.googleapis.com/v1alpha";

// --- RS256 JWT → access token ---
const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const payload = Buffer.from(
  JSON.stringify({
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }),
).toString("base64url");
const signer = crypto.createSign("RSA-SHA256");
signer.update(`${header}.${payload}`);
const signature = signer.sign(key.private_key).toString("base64url");

const tokenRes = await fetch(TOKEN_URL, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: `${header}.${payload}.${signature}`,
  }),
});
if (!tokenRes.ok) {
  console.error("❌ 换取 token 失败：", tokenRes.status, await tokenRes.text());
  process.exit(1);
}
const { access_token: token } = await tokenRes.json();
console.log("✅ OAuth token OK\n");

async function funnel(label, body) {
  const res = await fetch(`${ALPHA_BASE}/properties/${propertyId}:runFunnelReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`❌ ${label}（HTTP ${res.status}）：`, text.slice(0, 600));
    return null;
  }
  console.log(`✅ ${label}`);
  return JSON.parse(text);
}

/** 用户级排除 internal 的 segment 定义（PERMANENT：出现过即永久排除） */
function excludeInternalSegment() {
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
                segmentEventFilter: {
                  eventName: "*",
                  segmentParameterFilterExpression: {
                    orGroup: {
                      expressions: [
                        {
                          segmentParameterFilter: {
                            eventParameterName: "audience_type",
                            stringFilter: { matchType: "EXACT", value: "internal" },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          ],
        },
      },
    },
  };
}

function summarizeTable(resp) {
  const table = resp.funnelTable;
  if (!table) return;
  console.log("   funnelTable 维度:", (table.dimensionHeaders ?? []).map((h) => h.name).join(", "));
  console.log("   funnelTable 指标:", (table.metricHeaders ?? []).map((h) => `${h.name}(${h.type})`).join(", "));
  for (const row of table.rows ?? []) {
    const dims = (row.dimensionValues ?? []).map((d) => d.value).join(" | ");
    const metrics = (row.metricValues ?? []).map((m) => m.value).join(", ");
    console.log(`   [${dims}] → ${metrics}`);
  }
  const sampling = table.metadata?.samplingMetadatas;
  if (sampling && sampling.length > 0) {
    for (const s of sampling) {
      console.log(`   ⚠️ 采样: ${s.samplesReadCount}/${s.samplingSpaceSize}`);
    }
  } else {
    console.log("   （无采样标记）");
  }
}

// ---------------------------------------------------------------------------
// 1. 登录漏斗：封闭 + 30 分钟窗口 + 排除 internal
// ---------------------------------------------------------------------------
const loginResp = await funnel("登录漏斗（login_start → login，30 分钟，排除 internal）", {
  dateRanges: [{ startDate: "27daysAgo", endDate: "today" }],
  funnel: {
    isOpenFunnel: false,
    steps: [
      {
        name: "发起 Google 登录",
        filterExpression: { funnelEventFilter: { eventName: "login_start" } },
      },
      {
        name: "登录成功",
        filterExpression: { funnelEventFilter: { eventName: "login" } },
        isDirectlyFollowedBy: false,
        withinDurationFromPriorStep: "1800s",
      },
    ],
  },
  segments: [excludeInternalSegment()],
});
if (loginResp) summarizeTable(loginResp);
console.log("");

// ---------------------------------------------------------------------------
// 2. 购买漏斗（4 步完整结构；后两步事件暂无数据，验证请求合法性）
// ---------------------------------------------------------------------------
const purchaseResp = await funnel("购买漏斗（view_item[3 参数] → checkout_click → begin_checkout → purchase）", {
  dateRanges: [{ startDate: "27daysAgo", endDate: "today" }],
  funnel: {
    isOpenFunnel: false,
    steps: [
      {
        name: "查看套餐",
        filterExpression: {
          funnelEventFilter: {
            eventName: "view_item",
            funnelParameterFilterExpression: {
              andGroup: {
                expressions: [
                  {
                    funnelParameterFilter: {
                      eventParameterName: "checkout_eligible",
                      stringFilter: { matchType: "EXACT", value: "true" },
                    },
                  },
                  {
                    funnelParameterFilter: {
                      eventParameterName: "checkout_mode",
                      stringFilter: { matchType: "EXACT", value: "public" },
                    },
                  },
                  {
                    funnelParameterFilter: {
                      eventParameterName: "payment_environment",
                      stringFilter: { matchType: "EXACT", value: "live" },
                    },
                  },
                ],
              },
            },
          },
        },
      },
      {
        name: "点击购买",
        filterExpression: { funnelEventFilter: { eventName: "checkout_click" } },
        isDirectlyFollowedBy: false,
        withinDurationFromPriorStep: "604800s",
      },
      {
        name: "创建结账",
        filterExpression: { funnelEventFilter: { eventName: "begin_checkout" } },
        isDirectlyFollowedBy: false,
        withinDurationFromPriorStep: "1800s",
      },
      {
        name: "支付成功",
        filterExpression: { funnelEventFilter: { eventName: "purchase" } },
        isDirectlyFollowedBy: false,
        withinDurationFromPriorStep: "604800s",
      },
    ],
  },
  segments: [excludeInternalSegment()],
});
if (purchaseResp) summarizeTable(purchaseResp);
console.log("");

// ---------------------------------------------------------------------------
// 3. 拆分维度 deviceCategory
// ---------------------------------------------------------------------------
const deviceResp = await funnel("登录漏斗 + deviceCategory 拆分", {
  dateRanges: [{ startDate: "27daysAgo", endDate: "today" }],
  funnel: {
    isOpenFunnel: false,
    steps: [
      { name: "发起 Google 登录", filterExpression: { funnelEventFilter: { eventName: "login_start" } } },
      {
        name: "登录成功",
        filterExpression: { funnelEventFilter: { eventName: "login" } },
        isDirectlyFollowedBy: false,
        withinDurationFromPriorStep: "1800s",
      },
    ],
  },
  funnelBreakdown: { breakdownDimension: { name: "deviceCategory" }, limit: "10" },
  segments: [excludeInternalSegment()],
});
if (deviceResp) summarizeTable(deviceResp);
console.log("");

// ---------------------------------------------------------------------------
// 4. 辅助诊断：ai_font_view 与登录页 PV（runReport）
// ---------------------------------------------------------------------------
const v1beta = async (body, label) => {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`❌ ${label}:`, res.status, (await res.text()).slice(0, 300));
    return;
  }
  const data = await res.json();
  console.log(`✅ ${label}`);
  for (const row of data.rows ?? []) {
    console.log(
      `   ${(row.dimensionValues ?? []).map((d) => d.value).join(" | ")} → ${(row.metricValues ?? []).map((m) => m.value).join(", ")}`,
    );
  }
};

await v1beta(
  {
    dateRanges: [{ startDate: "27daysAgo", endDate: "today" }],
    dimensions: [{ name: "eventName" }],
    metrics: [{ name: "totalUsers" }, { name: "eventCount" }],
    dimensionFilter: {
      orGroup: {
        expressions: [
          { filter: { fieldName: "eventName", stringFilter: { matchType: "EXACT", value: "ai_font_view" } } },
          { filter: { fieldName: "eventName", stringFilter: { matchType: "EXACT", value: "view_item" } } },
        ],
      },
    },
  },
  "ai_font_view / view_item 辅助指标",
);

await v1beta(
  {
    dateRanges: [{ startDate: "27daysAgo", endDate: "today" }],
    dimensions: [{ name: "pagePath" }],
    metrics: [{ name: "totalUsers" }, { name: "screenPageViews" }],
    dimensionFilter: {
      andGroup: {
        expressions: [
          {
            filter: {
              fieldName: "pagePath",
              orGroup: {
                expressions: [
                  { filter: { fieldName: "pagePath", stringFilter: { matchType: "BEGINS_WITH", value: "/login" } } },
                  { filter: { fieldName: "pagePath", stringFilter: { matchType: "EXACT", value: "/ai-font-generator" } } },
                  { filter: { fieldName: "pagePath", stringFilter: { matchType: "BEGINS_WITH", value: "/pricing" } } },
                ],
              },
            },
          },
        ],
      },
    },
    limit: 20,
  },
  "关键页面 PV（/login、/ai-font-generator、/pricing）",
);
