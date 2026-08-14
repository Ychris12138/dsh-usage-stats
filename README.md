# dsh-usage-stats

[![CI](https://github.com/Ychris12138/dsh-usage-stats/actions/workflows/ci.yml/badge.svg)](https://github.com/Ychris12138/dsh-usage-stats/actions/workflows/ci.yml)
[![version](https://img.shields.io/badge/version-0.1.2-1f6feb)](https://github.com/Ychris12138/dsh-usage-stats/releases)
[![license](https://img.shields.io/badge/license-MIT-2da44e)](LICENSE)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 网页端提供 Token 用量热图、多供应商余额与订阅额度。

Token usage heatmap, provider/model breakdowns, account balances, and subscription quotas for the DeepSeek Harness Web GUI (`dsh web`).

![dsh-usage-stats panel](docs/images/usage-panel.png)

## 功能 / Features

| 功能 | 说明 |
| --- | --- |
| 统一供应商账户卡 | 一次只显示当前选择的供应商；DeepSeek 等展示余额，OpenCode Go、Z.ai 展示订阅额度 |
| 订阅额度 | OpenCode Go 显示 5 小时/每周/每月窗口；Z.ai Coding Plan 显示会话、周额度与 MCP 月度额度 |
| 用量概览 | 今日、本月、累计 Token，以及今日缓存命中率 |
| 月历热图 | 按月浏览；颜色越深表示用量越高 |
| 日期下钻 | 点击日期查看分供应商/分模型 Token、占比和输入/输出/缓存明细 |
| 增量聚合 | 只折叠新增事件；检测到日志截断或重写时自动从头计算 |
| 本机边界 | API 同时校验 peer socket 与 Host；浏览器永远拿不到 API key |

界面支持中文和英文。余额与订阅共用同一套供应商卡片框架：余额型供应商在卡内显示金额，订阅型供应商显示分窗口进度条；选择器切换后只渲染当前供应商。各类请求独立刷新，打开面板后立即加载，之后 Token 用量每分钟刷新、余额和订阅额度每五分钟刷新。

## 安装 / Installation

需要 DeepSeek Harness 的 `web` profile（面向 `@deepseek-ai/dsh >= 0.1.0-rc.6`）。

### 推荐：DSH 插件命令

通过 DSH 自带的插件命令安装并注册 bundle：

```bash
dsh plugin --profile web add "github:Ychris12138/dsh-usage-stats"
```

该命令会把插件安装到 `web` profile，并从包内声明的 `cordis.patch.yml` 挂载服务端插件。已经运行的 `dsh web` 需要重启，浏览器随后硬刷新。

升级或卸载：

```bash
dsh plugin --profile web update dsh-usage-stats
dsh plugin --profile web remove dsh-usage-stats
```

### 兼容安装器

无法使用 `dsh plugin` 时，也可以使用随 Node.js 提供的 `npx` 安装器：

在 PowerShell、命令提示符或 macOS/Linux 终端运行同一条命令：

```bash
npx --yes github:Ychris12138/dsh-usage-stats
```

安装器会自动完成两件事：把运行文件复制到 `~/.dsh/profiles/node_modules/dsh-usage-stats`，并在 `profiles/web/cordis.patch.yml` 中幂等启用插件。重复运行同一命令即可更新，不会重复添加配置。

`dsh plugin` 与 `npx` 是两条独立安装路径，请选择其中一种；不要在保留手工 Cordis patch 条目的同时再注册 bundle，否则会重复挂载插件。

如设置了 `DSH_HOME`，安装器会使用该目录而不是 `~/.dsh`。可先预览或只检查现有安装：

```bash
npx --yes github:Ychris12138/dsh-usage-stats --dry-run
npx --yes github:Ychris12138/dsh-usage-stats --check
```

如果不希望安装器修改 Cordis patch，可加 `--no-enable`，再自行配置。

### 可选：配置余额查询

余额查询会**自动读取 Harness 中已配置的供应商**：官方 DeepSeek 路由（`llm-deepseek`）以及每个 pi-ai 供应商 profile（`llm-pi-ai`，如 `opencode`、`opencode-go`、`openrouter`、`ark` 等）。每个供应商的 API key 由 Harness 的凭据服务按需解析，插件不存储任何 key。用量统计无需 key。

内置的余额查询方案：

| 供应商 id | 余额接口 |
| --- | --- |
| `deepseek` / `deepseek-official` | `{baseURL}/user/balance` |
| `openrouter` | `{baseURL}/api/v1/credits` |
| `moonshotai` / `moonshotai-cn` / `kimi` | `{baseURL}/v1/users/me/balance` |
| `zai` / `zai-coding-cn` | `{baseURL}/api/paas/v4/balance` |

其余供应商（如 OpenCode Go、火山方舟、OpenAI、Anthropic 等）没有公开的余额查询接口，面板会明确显示"该供应商没有公开的余额查询接口"，而不是报错。

以 DeepSeek 为例，凭据保存在：

```yaml
# ~/.dsh/.credentials.yaml
DEEPSEEK_API_KEY: sk-your-key-here
```

pi-ai 供应商（如 ark）的凭据按其 profile 里的 `apiKeyEnv` 保存（例如 `ARK_API_KEY`）。安装器不会读取、创建或修改凭据文件。不要把真实 key 提交到 Git，也不要把它粘贴给编码 Agent。

### 可选：配置订阅额度

订阅额度不是账户余额，因此使用独立的进度条界面。只配置你实际使用的供应商即可：

```yaml
# ~/.dsh/.credentials.yaml
OPENCODE_GO_API_KEY: sk-opencode-your-key
ZAI_API_KEY: your-zai-key
# 中国区 Z.ai 用户可选；默认 global
ZAI_API_REGION: bigmodel-cn
```

OpenCode Go 按以下顺序寻找凭据：

1. Harness 凭据 `OPENCODE_GO_API_KEY`；
2. OpenCode 自己的 `~/.local/share/opencode/auth.json`（`opencode-go`，回退 `opencode`）；
3. 高级兼容回退：`OPENCODE_GO_AUTH_COOKIE` + `OPENCODE_GO_WORKSPACE_ID`。

前两种方式调用 `https://opencode.ai/zen/go/v1/usage`。它使用 `sk-opencode-…` Bearer Key，安装最简单，但目前仍是 OpenCode 自用的**未公开文档接口**，将来可能变化。第三种方式读取登录后的 workspace 页面，只建议接口发生兼容问题时临时使用；浏览器 Cookie 等同登录凭据，不应提交到 Git、日志或 issue。

Z.ai 使用 Coding Plan 的 quota/subscription 接口；全球区请求 `api.z.ai`，中国区请求 `open.bigmodel.cn`。选择 Z.ai 时优先展示更适合订阅计划的比例窗口，不会同时再堆叠一张余额卡。

### 重启

```bash
dsh web
```

浏览器硬刷新后，侧边栏底部会出现“用量/余额”（Usage/Balance）入口。

<details>
<summary>无法使用 npx 时：从源码安装</summary>

```bash
git clone https://github.com/Ychris12138/dsh-usage-stats.git
cd dsh-usage-stats
node scripts/install.mjs
```

</details>

## 使用 / Usage

- 点击侧边栏入口打开面板。
- 使用“当前供应商”选择器切换账户视图；面板一次只显示一个供应商。
- DeepSeek、OpenRouter、Moonshot/Kimi 等余额型供应商显示金额；OpenCode Go 与 Z.ai 显示订阅比例、窗口和重置时间。
- 未配置、凭据失效、限流和接口不可用会在同一张供应商卡片中显示不同状态。
- 使用 `‹`、`›` 切换月份，点击“今天”返回当前月份。
- 点击热图日期或最近 14 个日历日列表，查看当天的分供应商/分模型明细（同一模型来自不同供应商会分开显示，如 `deepseek-official · deepseek-v4-flash` 与 `ark · deepseek-v4-flash`）。
- 标题栏刷新按钮会同时重新请求用量、供应商列表、当前供应商余额和订阅额度。

“最近 14 天”按本地日历计算，只显示窗口内存在用量的日期；未来时间戳不会计入该列表。

## Agent 友好安装 / Agent-friendly installation

可以把下面整段直接交给 Codex、Claude Code 或其他本地编码 Agent：

```text
Install or update dsh-usage-stats from:
https://github.com/Ychris12138/dsh-usage-stats

Constraints:
- Resolve DSH_HOME from the environment; otherwise use ~/.dsh.
- Do not read, print, edit, or request .credentials.yaml, auth.json, cookies, or any API key.
- Do not expose the plugin through a reverse proxy.
- Do not restart or terminate an existing dsh process without asking me.

Procedure:
1. Confirm node, npx, and dsh are available.
2. Prefer: dsh plugin --profile web add "github:Ychris12138/dsh-usage-stats"
3. If the dsh plugin command is unavailable, fall back to: npx --yes github:Ychris12138/dsh-usage-stats
4. Do not combine the bundle installation with an existing manual dsh-usage-stats Cordis patch entry.
5. For the npx fallback, require the installer to report a verified package and exactly one Cordis patch entry, then run it again with --check.
6. Report which installation path was used and its resolved profile paths.
7. If dsh web is already running, tell me a restart is needed and stop.

Optional subscription setup (do not handle secrets yourself):
- Tell me that OpenCode Go can reuse its local auth.json automatically, or I can add OPENCODE_GO_API_KEY to the Harness credentials file myself.
- Tell me that Z.ai requires ZAI_API_KEY; China-region accounts may also set ZAI_API_REGION=bigmodel-cn.
- Never ask me to paste a key or browser cookie into chat.
```

安装器本身提供清晰的退出码：未知参数返回 `2`；文件、版本或配置验证失败返回非零；成功时输出已验证版本、安装路径和 patch 路径。因此 Agent 不需要自行解析或重写 YAML。

Agent 如果只获准检查而不能修改，应运行：

```bash
npx --yes github:Ychris12138/dsh-usage-stats --check
```

## 隐私与安全 / Privacy & security

- API key、OpenCode auth.json 内容与兼容 Cookie 不会发送到浏览器、写入插件缓存或日志。服务端只通过 HTTPS 把相应凭据发往对应供应商域名。
- 余额响应只包含 `isAvailable`、`currency`、`total`、`granted`、`toppedUp` 和 `fetchedAt`，不包含 key。
- 订阅响应只包含供应商、计划、状态、额度窗口百分比和重置时间，不包含 key、Cookie 或 workspace 页面正文。
- 用量缓存在 `~/.dsh/storages/usage-stats-cache.json`，只保存按日期/供应商/模型聚合的 Token、会话 id、不透明修订号与折叠游标，不保存提示词、回复正文或文件路径。
- 四个端点仅接受 GET，并同时校验 `req.socket.remoteAddress` 与 Host；支持 IPv4、IPv4-mapped IPv6 和 `[::1]:port`。

本机反向代理会让插件看到代理自身的回环地址。请勿把这些端点经反向代理暴露到局域网或公网；如确需代理，请在代理层增加可靠的认证与访问控制。

安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要在公开 issue 中附带 API key、会话内容或可利用细节。

## 聚合与正确性 / Aggregation & correctness

统计值来自 `assistant/chunk` 或 `assistant/message` 事件中的 provider-reported `usage`，不是本地估算。相同 turn/step 的后续 usage 样本会替换前一个样本，与 Harness 的 token usage projection 语义一致。每个样本按 `provider/model` 归集（取自 `data.message.source`，兜底 `request/header` 的 `data.header.config`），因此同一模型在不同供应商下会分开统计。

- 活跃会话只处理内存中新追加的事件。
- 持久化会话优先使用 `sessionPersistence.listSnapshots()` 的不透明 revision；revision 未变化时不读取日志。
- seq 出现缺口、revision 变化但没有新尾部，或 live/persisted 状态切换时，会对该会话完整重折叠。
- 聚合请求采用 single-flight，并在同一临界区内原子写入缓存，避免并发保存覆盖。

开发环境中的真实日志曾以四条路径交叉核对：原始 JSONL/Zstandard artifact、`session.history`、插件端点和官方 `tokenUsage` projection。验证脚本会逐会话比较，并在文件缺失、读取失败、覆盖不完整或数值不一致时返回非零退出码。

## 开发与验证 / Development

客户端是无需构建步骤的手写 `__ModuleLoader__` bundle；服务端是 Cordis 插件，聚合核心位于纯函数模块。

```bash
npm install
npm run check
npm test
npm pack --dry-run
```

`npm test` 完全离线运行：客户端渲染/请求并发/币种回归，以及服务端的 IPv6、外部 peer、GET-only、会话切换和日志重写回归。干净 clone 会从项目 `devDependencies` 解析 React；只有显式设置 `SMOKE_NODE_MODULES` 时才改用其他模块目录。

真实数据集成验证需要先运行 `dsh web`（默认 `127.0.0.1:3080`）：

```bash
npm run validate:live
node scripts/check-balance.mjs
```

`validate:live` 依赖 JSONL/Zstandard 会话 artifact，并要求每个带 token projection 的会话都有可读 raw artifact；否则会明确失败，而不是给出假阳性。`check-balance.mjs` 会访问官方 API 并打印余额响应，适合本机诊断，不应把输出粘贴到公开 issue。

所有服务端脚本都遵循 `DSH_HOME`；未设置时默认为 `~/.dsh`。

## API

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/api/usage-stats/usage` | 按日期/供应商/模型统计的 Token、缓存命中率与更新时间 |
| `GET` | `/api/usage-stats/providers` | 已配置的供应商列表（含余额方案与凭据是否已配置） |
| `GET` | `/api/usage-stats/balance?provider=<id>` | 所选供应商的脱敏余额与获取时间；省略 `provider` 时默认官方 DeepSeek 路由 |
| `GET` | `/api/usage-stats/subscriptions` | OpenCode Go 与 Z.ai 的脱敏订阅状态、百分比窗口和重置时间 |

其他方法返回 `405`，非回环请求返回 `403`。响应均为 JSON，并带 `Cache-Control: no-cache`。

## 项目结构

```text
lib/index.js              server routes, incremental cache, provider-aware balance
lib/usage.js              pure token-usage aggregation (provider/model keys)
lib/balance.js            provider balance schemes (deepseek/openrouter/moonshot/zai)
lib/subscriptions.js      normalized OpenCode Go and Z.ai quota adapters
lib/client.js             balance and subscription UIs, provider picker, heatmap
scripts/smoke-client.mjs  offline client regressions
scripts/install.mjs       cross-platform idempotent installer
scripts/test-install.mjs  installer regression and idempotency test
scripts/test-server.mjs   offline server regressions
scripts/test-balance.mjs  offline balance-scheme unit tests
scripts/test-subscriptions.mjs offline subscription-adapter tests
scripts/validate-fold.mjs live projection comparison
scripts/verify-raw.mjs    four-path raw-data verification
```

## 兼容性说明

当前版本为 `0.1.2`。插件依赖 DeepSeek Harness 的客户端模块加载器、Cordis 服务和 session persistence 接口；Harness 预发布版本升级后如这些内部接口变化，可能需要同步适配。

## 参考与致谢 / References

- [Javis603/token-monitor](https://github.com/Javis603/token-monitor)：参考其多 provider 配额归一化与 Z.ai 限额解析。
- [xiaoqi20/dsh-opencode-go-usage](https://github.com/xiaoqi20/dsh-opencode-go-usage)：参考其 DSH 凭据接入、OpenCode `auth.json` 回退与 Bearer usage endpoint。

本项目重新实现统一的 subscription adapter 和单供应商账户卡片，不复制上述项目的 UI；OpenCode Go 的 usage endpoint 尚未公开文档，因此保留 dashboard 兼容回退并由测试锁定两种响应格式。

## License

[MIT](LICENSE)
