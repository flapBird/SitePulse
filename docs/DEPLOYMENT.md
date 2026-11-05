# SitePulse 部署指南

从零开始：配置 Google Service Account 只读访问 GA4 → 本地开发 → 部署到 Cloudflare Workers。

## 一、Google Service Account 授权（只读）

### 1. 创建服务账号并下载密钥

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)，新建（或选择）一个项目。
2. 启用 **Google Analytics Data API**：API 和服务 → 库 → 搜索 "Google Analytics Data API" → 启用。
3. IAM 和管理 → 服务账号 → **创建服务账号**（名称随意，如 `sitepulse-reader`；不需要授予项目角色、不需要开启其他权限）。
4. 进入该服务账号 → 密钥 → **添加密钥 → JSON**，浏览器会下载一个 JSON 密钥文件。**妥善保管，这就是 `GA_SERVICE_ACCOUNT_JSON` 的内容。**

### 2. 把服务账号加为 GA4 的用户（查看者）

对**每一个**要监控的 GA4 Property：

1. 打开 [Google Analytics](https://analytics.google.com/) → 管理（齿轮）→ 对应 Property → **属性访问管理**。
2. **+** → 添加用户 → 填入服务账号邮箱（形如 `sitepulse-reader@xxx.iam.gserviceaccount.com`）。
3. 角色 = **查看者**（只读，符合最小权限原则）→ 添加。

> 也可以在**账号级**（Account Access Management）一次性授权账号下全部 Property，但属性级授权更可控。
> 授权后可能需要几分钟生效。

### 3. 找到各站点的 Property ID

GA4 → 管理 → 属性设置 → **属性 ID**（纯数字，如 `123456789`）。部署后在站点管理界面填入即可。

## 二、本地开发

```sh
pnpm install
cp .dev.vars.example .dev.vars   # 填入密钥
```

`.dev.vars` 两个变量：

```
# Service Account 密钥 JSON 全文（压缩成一行即可，保留 \n 转义）
GA_SERVICE_ACCOUNT_JSON={"type":"service_account",...,"client_email":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"}
# Dashboard 登录密码（本地调试建议也设置，行为与线上一致）
DASHBOARD_PASSWORD=dev-password
```

启动（本地跑在 workerd，KV / Cache 与线上一致地模拟）：

```sh
pnpm dev        # http://localhost:3001
```

添加站点（二选一）：

- **管理界面**：登录后进入「站点管理」→ 新增（本地开发时数据写入 Miniflare 模拟的 KV，仅本机有效）。
- **种子文件**：编辑 `config/sites.json`（参考 `config/sites.example.json`），首次部署后仍可在界面继续管理。

> `timeZone` 填与该 GA4 Property 报告时区一致的 IANA 时区（如 `Asia/Shanghai`），「今日/昨日/同期」的口径才准确。

## 三、部署到 Cloudflare Workers

### 1. 登录 Cloudflare

```sh
pnpm exec cf auth login          # 浏览器授权（推荐）
# 或 CI 环境：export CLOUDFLARE_API_TOKEN=... （用 "Edit Cloudflare Workers" 模板）
export CLOUDFLARE_ACCOUNT_ID=…   # 或写在 cloudflare.config.ts 的 accountId
```

### 2. 创建 KV 命名空间并绑定（站点在线管理所需）

```sh
pnpm exec cf kv namespaces create sitepulse-sites
```

把命令返回的命名空间 **ID** 填到 `cloudflare.config.ts`：

```ts
SITES_KV: bindings.kv({ id: "REPLACE_WITH_KV_NAMESPACE_ID" }),  // ← 替换成真实 ID
```

> KV 属 Cloudflare 免费额度（读 10 万次/天、写 1 千次/天），站点管理是低频操作，不会超限。
> 查询结果缓存走 Cache API（不计费、无 KV 写限制），不占用该 KV。

### 3. 配置生产密钥

两个 secret 已在 `cloudflare.config.ts` 中用 `bindings.secret()` 声明。二选一：

**本地一次性部署时随包携带**（生成 `secrets.production.json`，已被 .gitignore 排除）：

```sh
node scripts/gen-secrets.mjs ~/Downloads/你的密钥.json        # 密码默认取 .dev.vars
pnpm exec cf deploy --secrets-file ./secrets.production.json # 构建并带密钥部署
```

部署成功后 Worker 上已永久带有密钥，之后的部署（含 GitHub 构建）无需再提供；建议删除该文件。

**或部署后在 Dashboard / CLI 配置**：

```sh
pnpm exec cf workers secrets update GA_SERVICE_ACCOUNT_JSON --worker sitepulse --type secret_text --text '<密钥JSON字符串>'
pnpm exec cf workers secrets update DASHBOARD_PASSWORD --worker sitepulse --type secret_text --text '<你的密码>'
```

（也可在 Cloudflare Dashboard → Workers & Pages → sitepulse → Settings → Variables 中添加，类型选 Secret。）

### 4. 部署

```sh
pnpm deploy        # = vinext-cloudflare deploy（构建 + 部署 Worker）
```

部署完成会输出 `https://sitepulse.<你的子域>.workers.dev`。首次访问要求输入登录密码（若设置了 `DASHBOARD_PASSWORD`）。

### 5. （推荐）绑定自定义域名 + 加固

- Workers & Pages → sitepulse → Domains & Routes → Add Custom Domain。
- Dashboard 是内部工具，建议再加一层 Cloudflare Access（Zero Trust → Access → Applications → 自托管应用，策略限定你的邮箱），即使密码泄露也有第二道门。

## 四、配额、缓存与重试

| 项目 | 策略 |
| --- | --- |
| 请求数 | 每站点每轮刷新仅 2~3 次 GA4 HTTP 调用（实时 ×2、历史/详情用 batchRunReports 合并请求） |
| 缓存 | 实时 60s、历史 5 分钟、详情 5 分钟（Cloudflare Cache API，边缘共享；「手动刷新」绕过读缓存但仍回写） |
| 重试 | 429/5xx/超时自动重试 1 次（抖动退避）；token 在内存复用，过期前 60s 刷新 |
| 并发 | 多站点并发上限 8，单站点失败不影响其他站点 |
| GA4 免费配额 | 标准 Property 每小时 200 core tokens；本应用的缓存策略下远低于上限。站点很多时可把实时自动刷新间隔调大（`components/dashboard-view.tsx` 的 `REFRESH_INTERVAL_MS`） |

## 五、常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 站点行显示「GA4 拒绝访问（403）」 | 服务账号没有加为该 Property 的用户，或角色不是查看者 → 见第一步第 2 节 |
| 「GA4 Property 不存在（404/400）」 | Property ID 填错（注意不是数据流 ID） |
| 「未配置 GA_SERVICE_ACCOUNT_JSON」 | 密钥变量没配置 → 见本地开发 / 生产密钥两节（本地 `.dev.vars`、生产 `cf workers secrets update`） |
| 「换取 Google 访问令牌失败（invalid_grant）」 | 密钥 JSON 不完整或私钥被改动，重新下载密钥 |
| 管理页提示「未绑定 SITES_KV」 | 未创建/绑定 KV → 见部署第 2 节 |
| 「今日/昨日」与 GA4 后台对不上 | 站点的 `timeZone` 与 GA4 Property 报告时区不一致 |
| 改了 `.dev.vars` / 密钥不生效 | 重启 `pnpm dev`；生产环境重新 `cf workers secrets update` 后无需重启 |

## 六、安全说明

- Service Account 只有 GA4 **只读**权限（scope: `analytics.readonly`），不会修改任何统计配置。
- 密钥仅存在于 Worker 的环境变量（secret）中，前端与 API 响应均不包含。
- 所有 Google API 请求由后端统一发起（`lib/ga4.ts`），浏览器只访问本应用的 `/api/*`。
- `.dev.vars`、`*.pem`、密钥 JSON 已被 `.gitignore` 排除，请勿提交到仓库。
