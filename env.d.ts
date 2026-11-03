/*
 * 项目自身的密钥/开关：通过 Cloudflare secrets（生产）或 .dev.vars（本地）配置，
 * 不在 cloudflare.config.ts 中声明。此处与生成的 .cloudflare/types/index.d.ts
 * 的 Cloudflare.Env 进行声明合并（tsconfig 已 include .cloudflare/types）。
 */
declare namespace Cloudflare {
  interface Env {
    /** Service Account 密钥 JSON 的完整内容（只读 analytics.readonly） */
    GA_SERVICE_ACCOUNT_JSON?: string;
    /** Dashboard 登录密码；不设置则完全开放访问 */
    DASHBOARD_PASSWORD?: string;
  }
}
