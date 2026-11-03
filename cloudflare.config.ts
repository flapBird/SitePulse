import { bindings, defineConfig, defineWorker } from "cf/config";

export default defineConfig({
  worker: defineWorker({
    name: "sitepulse",
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-11-03",
    compatibilityFlags: ["nodejs_compat"],
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    env: {
      ASSETS: bindings.assets(),
      IMAGES: bindings.images(),
      // 站点管理界面读写站点配置的 KV 命名空间。
      // 本地开发使用 Miniflare 模拟，无需真实 ID；部署前先
      // `cf kv namespaces create sitepulse-sites` 创建，再把返回的 ID 填到这里。
      SITES_KV: bindings.kv({ id: "REPLACE_WITH_KV_NAMESPACE_ID" }),
      // 密钥：本地在 .dev.vars 提供值，生产用 `cf workers secrets put` 配置
      GA_SERVICE_ACCOUNT_JSON: bindings.secret(),
      DASHBOARD_PASSWORD: bindings.secret(),
    },
  }),
});
