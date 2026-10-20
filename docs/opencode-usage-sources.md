# OpenCode 用量的几种来源

“本机用了多少 token”和“Go 订阅还剩多少额度”是不同指标，不能互相替代。

## Go 订阅额度

Usage Stats 优先使用当前 DSH 配置的 `OPENCODE_API_KEY`，读取 `https://opencode.ai/inference/go/v1/usage`。只有 404/405 才用同一密钥尝试旧 `/zen/go/v1/usage`；凭据被拒绝或限流时不轮换账户、不切换 Cookie。

官方当前源码保留了旧 usage 路径的[迁移代理](https://github.com/anomalyco/opencode/blob/133b1ebfafc3ae040b9b23ff3fcad49e273c9cf9/packages/console/app/src/lib/inference-proxy.ts)，但并未承诺它是稳定的公开 API。没有真实 Go 账户时，只能确认代码路径和模拟响应，不能声称余额已经对账通过。

如果显示“未配置”，应先在 DSH 配置自己的 Console API Key。仅在 OpenCode 客户端登录并不等于 DSH 有这把 Key；不要导出凭据数据库或在 issue 贴出 Key/Cookie。

官方[Go 文档](https://docs.opencode.ai/docs/go/)说明可在 Console 查看当前使用情况。它适合作为真实账户验收的参照，也覆盖其他客户端产生的账户用量。

## OpenCode 客户端本地统计

旧版客户端可以查看本地会话统计：

```sh
opencode stats --days 7 --models
```

V2 官方命令另有 JSON 和费用视图，先以安装版本的 help 为准：

```sh
opencode stats --help
opencode stats --days 7 --json
opencode stats --days 7 --models --cost
```

参见 [V2 官方命令文档](https://dev.opencode.ai/v2/docs/cli/commands/#stats)及[当前实现](https://github.com/anomalyco/opencode/blob/133b1ebfafc3ae040b9b23ff3fcad49e273c9cf9/packages/cli/src/commands/handlers/stats.ts)。这些数字来自所连接 OpenCode 服务记录的会话；它们不覆盖 DSH 等其他客户端的请求，也不能据此反推 Go 套餐余额、重置时间或账户账单。

## Cookie 与 Providers Hub

本插件保留的 Cookie 读取只兼容旧 Console workspace 页面。新版 Console 的页面/鉴权尚无真实账户验收，不能把它宣传成当前可靠的替代接口。Cookie 也不会在 API Key 查询失败后自动接管账户身份。

Providers Hub 的 `opencode` 徽标是本地“可用通道数/冷却状态”，不是 Go 剩余额度。配套 `creditBalance` 服务明确排除这项数据；不把通道数展示成积分、美元或订阅百分比。
