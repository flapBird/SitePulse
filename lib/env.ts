/**
 * 服务器端环境访问：整个应用唯一 import "cloudflare:workers" 的模块。
 * 路由处理器通过这里取绑定与密钥，lib 其余部分保持纯净、可测试。
 */

import { env as cfEnv } from "cloudflare:workers";
import { parseServiceAccount, type ServiceAccountCredentials } from "./ga4";
import type { KvLike } from "./sites";

export interface AppEnv {
  SITES_KV?: KvLike;
  GA_SERVICE_ACCOUNT_JSON?: string;
  DASHBOARD_PASSWORD?: string;
}

export function getEnv(): AppEnv {
  return cfEnv as unknown as AppEnv;
}

export function isPasswordProtected(): boolean {
  const password = getEnv().DASHBOARD_PASSWORD;
  return typeof password === "string" && password.length > 0;
}

export type CredentialResult =
  | { ok: true; cred: ServiceAccountCredentials }
  | { ok: false; code: "UNCONFIGURED" | "CONFIG"; message: string };

/** 解析 GA_SERVICE_ACCOUNT_JSON；未配置或格式错误时给出可操作的提示 */
export function getCredential(): CredentialResult {
  const raw = getEnv().GA_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) {
    return {
      ok: false,
      code: "UNCONFIGURED",
      message: "未配置 GA_SERVICE_ACCOUNT_JSON：请把 Service Account 密钥 JSON 设为环境变量（见 docs/DEPLOYMENT.md）",
    };
  }
  try {
    return { ok: true, cred: parseServiceAccount(raw) };
  } catch (err) {
    return {
      ok: false,
      code: "CONFIG",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
