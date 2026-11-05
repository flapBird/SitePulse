import { bindings, defineConfig, defineWorker } from "cf/config";

export default defineConfig({
  worker: defineWorker({
    name: "sitepulse",
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-11-03",
    compatibilityFlags: ["nodejs_compat"],
    // 自定义域名（与 Dashboard 绑定保持一致，否则部署会因配置冲突被拒绝）
    domains: ["monitor.leeswalvpn.ccwu.cc"],
    // 与 Dashboard 当前设置保持一致（cf 严格模式下，配置与 Dashboard 不一致会被拒绝部署；
    // 如需开关 workers.dev / 预览地址，在 Dashboard 修改后同步这里）
    workersDev: true,
    previewUrls: true,
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
      SITES_KV: bindings.kv({ id: "1cf494aa3c914580b16a789f8b8f3f68" }),
      // 密钥：本地在 .dev.vars 提供值，生产用 `cf workers secrets put` 配置
      GA_SERVICE_ACCOUNT_JSON: bindings.secret(),
      DASHBOARD_PASSWORD: bindings.secret(),
    },
  }),
});
