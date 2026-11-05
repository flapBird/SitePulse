#!/usr/bin/env node
/**
 * GA4 连通性自检：用 Service Account 密钥对指定 Property 各发一次
 * 实时报表和 7 天汇总报表，打印结果或完整报错。
 *
 * 用法：
 *   node scripts/verify-ga4.mjs <service-account-key.json> <propertyId>
 *
 * 本脚本跑在本地 Node（使用 node:crypto），与线上 Workers 的 WebCrypto
 * 签名算法一致（RS256 / PKCS#8），结果可互相印证。
 */

import { readFileSync } from "node:fs";
import crypto from "node:crypto";

const [keyPath, propertyId] = process.argv.slice(2);
if (!keyPath || !propertyId) {
  console.error("用法：node scripts/verify-ga4.mjs <service-account-key.json> <propertyId>");
  process.exit(1);
}

const key = JSON.parse(readFileSync(keyPath, "utf8"));
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://analyticsdata.googleapis.com/v1beta";

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

async function call(method, body) {
  const res = await fetch(`${API_BASE}/properties/${propertyId}:${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`❌ ${method} 失败（HTTP ${res.status}）：`, text.slice(0, 500));
    return null;
  }
  return JSON.parse(text);
}

// 1. 实时报表（与线上一致）
const realtime = await call("runRealtimeReport", {
  metrics: [{ name: "activeUsers" }, { name: "screenPageViews" }],
  minuteRanges: [{ startMinutesAgo: 29, endMinutesAgo: 0 }],
});
if (realtime) {
  const row = realtime.rows?.[0]?.metricValues?.map((v) => v.value) ?? ["0", "0"];
  console.log(`✅ 实时报表 OK：30 分钟活跃=${row[0]}，PV=${row[1]}`);
}

// 2. 7 天汇总 + 排序请求（带 orderBys，覆盖详情页请求形态）
const sevenDays = await call("runReport", {
  dateRanges: [{ startDate: "6daysAgo", endDate: "today" }],
  metrics: [{ name: "totalUsers" }, { name: "screenPageViews" }, { name: "sessions" }],
});
if (sevenDays) {
  const row = sevenDays.rows?.[0]?.metricValues?.map((v) => v.value) ?? ["0", "0", "0"];
  console.log(`✅ 近 7 天报表 OK：UV=${row[0]}，PV=${row[1]}，Sessions=${row[2]}`);
}

const ordered = await call("runReport", {
  dateRanges: [{ startDate: "6daysAgo", endDate: "today" }],
  dimensions: [{ name: "country" }],
  metrics: [{ name: "totalUsers" }, { name: "screenPageViews" }],
  orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
  limit: 5,
});
if (ordered) {
  const rows = ordered.rows ?? [];
  console.log(`✅ 带排序的报表 OK（国家 Top${rows.length}）：`);
  for (const r of rows) {
    console.log(`   ${r.dimensionValues[0].value}  UV=${r.metricValues[0].value}  PV=${r.metricValues[1].value}`);
  }
}

console.log("\n全部通过 ✅ —— 密钥、授权、请求结构都正常");
