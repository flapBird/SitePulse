import { defineConfig } from "vitest/config";

// 单元测试只测纯函数库（lib/），不加载项目的 vite.config.ts
// （其中的 Cloudflare 插件与测试环境不兼容，且 lib 不依赖 Workers 运行时）。
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
