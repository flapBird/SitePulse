# SitePulse

GA4 多站点流量监控 Dashboard —— 在一个看板里集中监控多个网站的 Google Analytics 4 数据，无需频繁切换 Property。

- **技术栈**：Next.js（App Router / TypeScript / Tailwind）on [vinext](https://github.com/cloudflare/vinext)，部署到 Cloudflare Workers。
- **数据**：Google Analytics Data API v1beta（Service Account，`analytics.readonly` 只读），后端统一请求，密钥不出后端。
- **无外部数据库**：站点配置 = `config/sites.json` 种子 + 管理界面写 Workers KV；查询缓存用 Cloudflare Cache API。

## 功能

| 模块 | 说明 |
| --- | --- |
| 实时监控 | 各站点过去 30 分钟活跃用户、PV、分钟级活跃趋势；60 秒自动刷新（页面隐藏时暂停） |
| 历史统计 | 今日 / 昨日 / 近 7 天 / 近 30 天的 UV、PV、Sessions 及环比（今日 vs 昨日、7 天 vs 前 7 天、30 天 vs 前 30 天） |
| 统一看板 | 全部站点一张表：可按实时活跃、PV、今日/7天/30天 UV·PV、今日增长率排序；行点击进详情 |
| 趋势分析 | 全站实时分钟趋势（面积图）；选中范围的全站/单站趋势（单日按小时、7/30 天按日，双线 UV/PV） |
| 异常提示 | 「今日 vs 昨日同期」为主、近 7 天/30 天环比为辅，变化超过阈值（默认 ±30%）标记 🔺/🔻 |
| 站点详情 | 国家/地区、设备类型、热门页面、流量来源（渠道 + 来源/媒介）Top 10 与范围切换 |
| 站点管理 | 新增 / 修改 / 删除站点（写入 KV 立即生效，无需重新部署）；种子文件兜底 |
| 访问保护 | 设置 `DASHBOARD_PASSWORD` 后全站需登录（HttpOnly Cookie 会话）；不设置则开放 |
| 运维可见 | 数据更新时间、缓存命中、每站点 GA4 错误码与中文原因、凭据/KV 配置自检 |

界面为桌面优先的暗色/浅色双主题管理后台，全部数据来自真实 GA4 查询（无任何模拟数据）。

## 快速开始

```sh
pnpm install
cp .dev.vars.example .dev.vars   # 填入 GA_SERVICE_ACCOUNT_JSON 与 DASHBOARD_PASSWORD
pnpm dev                         # http://localhost:3001
```

Service Account 创建、GA4 授权、KV 绑定、生产部署的完整步骤见 **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**。

## 站点配置

管理界面（推荐）：登录后进入「站点管理」，增删改即时生效。

种子文件（`config/sites.json`，示例见 `config/sites.example.json`）：

```json
{
  "version": 1,
  "anomalyThreshold": 0.3,
  "sites": [
    {
      "id": "example-com",
      "name": "示例主站",
      "url": "https://example.com",
      "propertyId": "123456789",
      "timeZone": "Asia/Shanghai",
      "note": "备注可选"
    }
  ]
}
```

- `propertyId`：GA4 后台 → 属性设置 → 属性 ID（纯数字）。
- `timeZone`：与 GA4 Property 的报告时区一致，省略时为 `Asia/Shanghai`。
- `anomalyThreshold`：异常判定阈值（0.3 = 变化 ±30% 触发标记）。
- 在管理界面首次保存后，KV 成为唯一数据源（含种子站点）；删除 KV 键 `sites` 可回到种子。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 本地开发（workerd，KV/Cache 本地模拟） |
| `pnpm build` | 生产构建 |
| `pnpm start` | 本地预览构建产物 |
| `pnpm deploy` | 构建并部署到 Cloudflare Workers |
| `pnpm test` | Vitest 单元测试 |
| `pnpm typecheck` | TypeScript 类型检查（新克隆仓库先执行一次 `cf workers types` 生成绑定类型） |
| `pnpm exec cf workers types` | 生成 Cloudflare 绑定类型（`.cloudflare/types`，dev/build 也会自动生成） |

## 架构速览

```
app/                     页面与 API 路由（route handlers）
  api/realtime           30 分钟活跃/PV + 分钟趋势（缓存 60s）
  api/history            今日/昨日/7天/30天 聚合 + 逐日/逐小时 + 异常（缓存 5min）
  api/sites[/id][/detail] 站点配置 CRUD（KV）与维度明细（缓存 5min）
  api/auth/*             登录 / 登出（HttpOnly Cookie 会话）
proxy.ts                 全站登录保护（Next.js 16 proxy 约定）
lib/
  ga4.ts                 GA4 REST 客户端：WebCrypto RS256 JWT → OAuth2 token（缓存）→ runReport/batch/runRealtimeReport，超时 + 重试 + 错误归一化
  cache.ts               Cloudflare Cache API + 内存双层缓存（forceRefresh 支持）
  sites.ts               种子 + KV 配置解析、zod 校验
  stats.ts               聚合引擎：周期汇总/环比/异常检测/补零（纯函数）
  datetime.ts            时区感知的「今日/昨日/同期」计算（Intl）
  queries.ts             每站点的 GA4 请求编排（并发上限 8，单站点隔离失败）
config/sites.json        站点种子配置
docs/DEPLOYMENT.md       部署与授权完整指南
```

配额与缓存策略、故障排查同见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。
