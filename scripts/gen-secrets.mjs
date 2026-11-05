#!/usr/bin/env node
/**
 * 生成 `cf deploy --secrets-file` 使用的密钥文件（secrets.production.json）。
 *
 * 用法：
 *   node scripts/gen-secrets.mjs <service-account-key.json> [password]
 *
 * - 第一个参数是 GCP 下载的 Service Account 密钥 JSON 文件路径；
 * - password 省略时自动读取 .dev.vars 中的 DASHBOARD_PASSWORD；
 * - 生成的文件已被 .gitignore 排除（secrets*.json），勿提交、勿外传。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [keyPath, passwordArg] = process.argv.slice(2);

if (!keyPath) {
  console.error("用法：node scripts/gen-secrets.mjs <service-account-key.json> [password]");
  console.error("password 省略时自动读取 .dev.vars 中的 DASHBOARD_PASSWORD");
  process.exit(1);
}
if (!existsSync(keyPath)) {
  console.error(`找不到密钥文件：${keyPath}`);
  process.exit(1);
}

const serviceAccount = readFileSync(keyPath, "utf8");
try {
  JSON.parse(serviceAccount);
} catch {
  console.error("密钥文件不是合法 JSON，请确认下载的是 Service Account 密钥（JSON 格式）");
  process.exit(1);
}

let password = passwordArg;
if (!password) {
  if (!existsSync(".dev.vars")) {
    console.error("未找到 .dev.vars，请把密码作为第二个参数传入");
    process.exit(1);
  }
  const match = /^DASHBOARD_PASSWORD=(.*)$/m.exec(readFileSync(".dev.vars", "utf8"));
  if (!match || !match[1].trim()) {
    console.error(".dev.vars 中没有 DASHBOARD_PASSWORD，请把密码作为第二个参数传入");
    process.exit(1);
  }
  password = match[1].trim();
}

writeFileSync(
  "secrets.production.json",
  `${JSON.stringify(
    {
      DASHBOARD_PASSWORD: password,
      GA_SERVICE_ACCOUNT_JSON: serviceAccount,
    },
    null,
    2,
  )}\n`,
);
console.log("✅ 已生成 secrets.production.json（已被 .gitignore 排除；部署完成后建议删除）");
