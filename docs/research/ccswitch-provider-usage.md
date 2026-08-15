# CC Switch 用量查询方案与 dsh-usage-stats 扩展设计

> 研究时间：2026-08-15
>
> CC Switch 基线：`farion1231/cc-switch@40d747c009bff6a6097d5094e57d205420d9b24c`
>
> New API 基线：`QuantumNous/new-api@47ba9d2c63d6dcbf3a183ee421b136ee1b1331ed`

## 结论

CC Switch 最值得借鉴的不是“允许用户写 JavaScript”，而是它把查询分成两个阶段：供应商适配器负责请求和解析，UI 只接收统一的余额或订阅窗口数据。对于本插件，建议保留现有统一供应商卡片，新增一个服务端 account adapter registry，并把当前分开的余额、OpenCode Go/Z.ai 订阅查询收敛成按当前供应商查询的单一接口。

首批实现范围建议为：

1. New API 余额：优先调用当前 New API 的 token-scoped `/api/usage/token/`，直接复用供应商推理 Token；旧版 `/api/user/self` + 管理 PAT 仅作为显式配置的兼容回退。
2. Token Plan：新增 Kimi、Z.ai/智谱、MiniMax 原生 adapter，继续输出当前 UI 已支持的百分比窗口。
3. 自定义模型/中转站：提供声明式请求 + JSON Pointer 提取器，不在 Harness 的 Node 进程中执行用户 JavaScript。
4. 只查询当前选中的供应商。供应商列表只返回元数据，切换供应商时再查询该供应商的 account snapshot。

## CC Switch 的核心抽象

CC Switch 把官方订阅自动查询、Token Plan/余额内置模板和自定义脚本区分开。非官方订阅默认要求用户明确选择查询方式，因为同一家服务可能同时提供余额和套餐额度，不能只凭 Base URL 自动判断。[CC Switch 用量查询文档](https://github.com/farion1231/cc-switch/blob/40d747c009bff6a6097d5094e57d205420d9b24c/docs/user-manual/zh/2-providers/2.5-usage-query.md#L1-L61)

它最终归一化为两种展示语义：

- 余额型：`planName / total / used / remaining / unit / isValid / invalidMessage / extra`，允许单对象或多套餐数组。[UsageData/UsageResult](https://github.com/farion1231/cc-switch/blob/40d747c009bff6a6097d5094e57d205420d9b24c/src-tauri/src/provider.rs#L310-L342)
- 订阅型：多个 `tier`，每个 tier 提供名称、已用百分比和重置时间；Token Plan 与官方订阅共用进度展示。[SubscriptionQuotaFooter](https://github.com/farion1231/cc-switch/blob/40d747c009bff6a6097d5094e57d205420d9b24c/src/components/SubscriptionQuotaFooter.tsx#L24-L78)

### 通用模板

CC Switch 的 General 预设是：

```http
GET {{baseUrl}}/user/balance
Authorization: Bearer {{apiKey}}
User-Agent: cc-switch/1.0
```

默认从 `response.balance` 提取 USD 余额。查询配置中显式填写的 API Key/Base URL 优先，留空时回退供应商自身配置，并移除 Base URL 尾部 `/`。[模板源码](https://github.com/farion1231/cc-switch/blob/40d747c009bff6a6097d5094e57d205420d9b24c/src/components/UsageScriptModal.tsx#L54-L88) [凭据回退逻辑](https://github.com/farion1231/cc-switch/blob/40d747c009bff6a6097d5094e57d205420d9b24c/src-tauri/src/services/provider/usage.rs#L96-L123)

模板里的 `response.is_active || true` 实际永远为 `true`，不能照搬；正确的默认语义应是 `response.is_active ?? true`。

### 自定义脚本

CC Switch 的 Custom 模式让 JavaScript 返回 `{ request, extractor }`：后端先在 QuickJS 中提取请求配置，发出 HTTP 请求，再把 JSON 响应传给 `extractor`，最后校验为 `UsageData[]`。[执行流程](https://github.com/farion1231/cc-switch/blob/40d747c009bff6a6097d5094e57d205420d9b24c/src-tauri/src/usage_script.rs#L8-L226) [返回字段校验](https://github.com/farion1231/cc-switch/blob/40d747c009bff6a6097d5094e57d205420d9b24c/src-tauri/src/usage_script.rs#L314-L419)

它为 JS 设置了 5 秒 CPU、16 MiB 内存和 256 KiB 栈限制；普通模板强制 HTTPS、同域同端口，但 Custom 模式会放开 HTTP 与跨域，以支持内网/自建服务。[运行时限制](https://github.com/farion1231/cc-switch/blob/40d747c009bff6a6097d5094e57d205420d9b24c/src-tauri/src/usage_script.rs#L26-L67) [URL 校验](https://github.com/farion1231/cc-switch/blob/40d747c009bff6a6097d5094e57d205420d9b24c/src-tauri/src/usage_script.rs#L446-L584)

这一能力不适合原样移植：

- Custom 的跨域/HTTP 放行会扩大 SSRF 范围。
- CCSwitch 直接把密钥替换进 JS 源码；密钥包含引号、反斜杠或换行时可能破坏源码。[占位符替换](https://github.com/farion1231/cc-switch/blob/40d747c009bff6a6097d5094e57d205420d9b24c/src-tauri/src/usage_script.rs#L423-L444)
- Harness 插件与主进程同域运行，任意脚本执行的故障和安全影响高于声明式映射带来的便利。

因此本插件应把“自定义”定义为可验证的 HTTP 描述符与 JSON Pointer 映射，而不是可执行代码。

## New API

### 推荐主路径：推理 Token 查询

当前 New API 新增了 token-scoped 查询：

```http
GET {origin}/api/usage/token/
Authorization: Bearer {providerApiKey}
```

路由使用只读 Token 鉴权；响应为：

```json
{
  "code": true,
  "message": "ok",
  "data": {
    "object": "token_usage",
    "name": "token name",
    "total_granted": 1500000,
    "total_used": 500000,
    "total_available": 1000000,
    "unlimited_quota": false,
    "expires_at": 0
  }
}
```

该接口可直接复用 Harness 中该 provider 的 `apiKeyEnv`，无需额外管理端令牌或 User ID。[路由](https://github.com/QuantumNous/new-api/blob/47ba9d2c63d6dcbf3a183ee421b136ee1b1331ed/router/api-router.go#L251-L258) [响应实现](https://github.com/QuantumNous/new-api/blob/47ba9d2c63d6dcbf3a183ee421b136ee1b1331ed/controller/token.go#L215-L261)

额度点到金额的换算不能硬编码。New API 默认 `QuotaPerUnit = 500000`，但这是可配置项；公共 `GET /api/status` 会返回部署实例实际的 `data.quota_per_unit`。[默认值](https://github.com/QuantumNous/new-api/blob/47ba9d2c63d6dcbf3a183ee421b136ee1b1331ed/common/constants.go#L13-L25) [status 字段](https://github.com/QuantumNous/new-api/blob/47ba9d2c63d6dcbf3a183ee421b136ee1b1331ed/controller/misc.go#L44-L81)

推荐归一化：

- `remaining = total_available / quota_per_unit`
- `used = total_used / quota_per_unit`
- `total = total_granted / quota_per_unit`
- `currency = "USD"`
- `unlimited_quota === true` 时主值显示 `∞`，不要把有限数值误当上限
- `expires_at > 0` 时显示到期时间；当前实现返回秒级时间戳

### 兼容回退：管理 PAT 查询

CC Switch 的 New API 模板使用：

```http
GET {baseUrl}/api/user/self
Content-Type: application/json
Authorization: Bearer {accessToken}
New-Api-User: {userId}
```

它读取 `data.group`、`data.quota`、`data.used_quota`，并按 500000 换算 USD；业务失败读取 `message`。[CC Switch New API 模板](https://github.com/farion1231/cc-switch/blob/40d747c009bff6a6097d5094e57d205420d9b24c/src/components/UsageScriptModal.tsx#L90-L116)

当前 New API 仍保留 `GET /api/user/self`，响应包含 `group/quota/used_quota`；不过鉴权契约已经简化为面板 PAT，可带或不带 `Bearer`，`New-Api-User` 不再参与鉴权。[路由与响应](https://github.com/QuantumNous/new-api/blob/47ba9d2c63d6dcbf3a183ee421b136ee1b1331ed/router/api-router.go#L82-L90) [用户字段](https://github.com/QuantumNous/new-api/blob/47ba9d2c63d6dcbf3a183ee421b136ee1b1331ed/controller/user.go#L481-L538) [PAT 调用契约](https://github.com/QuantumNous/new-api/blob/47ba9d2c63d6dcbf3a183ee421b136ee1b1331ed/docs/authentication.md#L308-L312)

因此兼容策略应为：

1. 显式选择 `new-api` adapter 后，先调用 `/api/usage/token/`。
2. 只有在 endpoint 为 404/405/明确不支持，且用户配置了独立管理 PAT 时，才回退 `/api/user/self`。
3. `userIdRef` 仅作为旧实例兼容字段，可选；不要要求新实例用户填写。
4. 不要用推理 API Key 盲试 `/api/user/self`，两类凭据语义不同。

## Token Plan

CC Switch 为 Token Plan 使用原生 adapter，而不是通用 JS。所有 adapter 最终产生 `{ name, utilization, resetsAt }`，所以 UI 无需了解上游响应结构。

| Provider | 请求 | 解析与周期 |
| --- | --- | --- |
| Kimi For Coding | `GET https://api.kimi.com/coding/v1/usages`；`Authorization: Bearer` | `limits[].detail.limit/remaining/resetTime` 为 5 小时窗口；`usage.limit/remaining/resetTime` 为周窗口；已用率 `(limit-remaining)/limit*100`。[源码](https://github.com/farion1231/cc-switch/blob/40d747c009bff6a6097d5094e57d205420d9b24c/src-tauri/src/services/coding_plan.rs#L103-L208) |
| Z.ai / 智谱个人版 | 全球 `https://api.z.ai/api/monitor/usage/quota/limit`，国内 `https://open.bigmodel.cn/...`；`Authorization: {apiKey}`，不加 Bearer | `data.limits[]` 的 `TOKENS_LIMIT/CREDIT_LIMIT`；`percentage` 是已用率，`nextResetTime` 是重置时间，`unit=3` 为 5 小时，`unit=6` 为周；`data.level` 为套餐标签。[源码](https://github.com/farion1231/cc-switch/blob/40d747c009bff6a6097d5094e57d205420d9b24c/src-tauri/src/services/coding_plan.rs#L211-L410) |
| MiniMax | 当前官方地址：中国 `https://www.minimaxi.com/v1/token_plan/remains`，国际 `https://www.minimax.io/v1/token_plan/remains`；Bearer。CC Switch 使用的旧 `api.* /v1/api/openplatform/coding_plan/remains` 仅作 404/405 兼容回退 | 仅取 `model_remains[].model_name === "general"`；`100-current_interval_remaining_percent` 为 5 小时已用率；仅 `current_weekly_status===1` 时显示周窗口，周已用率为 `100-current_weekly_remaining_percent`。[MiniMax 中国区文档](https://platform.minimaxi.com/docs/token-plan/faq) [MiniMax 国际区文档](https://platform.minimax.io/docs/token-plan/faq) [CC Switch 源码](https://github.com/farion1231/cc-switch/blob/40d747c009bff6a6097d5094e57d205420d9b24c/src-tauri/src/services/coding_plan.rs#L413-L496) [解析](https://github.com/farion1231/cc-switch/blob/40d747c009bff6a6097d5094e57d205420d9b24c/src-tauri/src/services/coding_plan.rs#L636-L700) |

智谱官方当前说明个人套餐同时具有 5 小时动态窗口和 7 天周期窗口，与上述归一化相符。[GLM Coding Plan 套餐说明](https://docs.bigmodel.cn/cn/coding-plan/overview)

MiniMax 的 endpoint 存在版本漂移风险，不能只用硬编码 URL 判定成功。实现时应以脱敏 fixture 锁定当前响应，并将 endpoint/path 放入 adapter 常量，允许后续兼容第二路径。

## 本插件现状与缺口

当前实现已经具备可复用的基础：

- [`lib/balance.js`](../../lib/balance.js) 是纯 balance registry，但 `balanceSchemeOf(providerId)` 完全依赖固定 provider ID，无法表达任意名称的 New API 或自定义 provider。
- [`lib/subscriptions.js`](../../lib/subscriptions.js) 已把 OpenCode Go 和 Z.ai 归一化成 `mode: subscription` + `windows[]`，这一 wire shape 可继续用于 Kimi/MiniMax。
- [`lib/index.js`](../../lib/index.js) 的 `configuredProviders()` 能读取官方 DeepSeek 与所有 `llm-pi-ai` provider 的 `id/displayName/apiKeyEnv/baseURL`，但会丢弃额外的 account-monitor 配置。
- [`lib/client.js`](../../lib/client.js) 已有统一 `ProviderAccountCard`，内部可切换余额与订阅窗口；但 `subscriptionIdFor()` 只硬编码 OpenCode Go/Z.ai。
- `/subscriptions` 是 `0.1.x` 兼容路由；`0.2.0` 客户端改用按 provider 的 `/account`，一次只请求当前选择项。服务端则按产品要求在启动时及每五分钟主动刷新所有已配置账户，以便面板读取缓存并在关闭时继续预警。

这里需要区分两类“自定义模型监测”：Harness 已产生的调用事件仍由现有本地统计按 `provider/model` 自动聚合，不需要为每个模型新增 adapter；本方案新增的是自定义 provider 或中转站的远端账户监测，例如余额、套餐窗口和重置时间。远端监测绑定在 `providerId`，不会改变已有的逐模型 token 统计口径。

主要结构问题不是缺少更多 `if (providerId === ...)`，而是缺少“provider 配置到 account adapter”的显式绑定。

## 推荐实现

### 1. 统一 wire protocol

服务端内部与客户端 wire shape 应使用同一个带 `mode` 判别字段的 union，避免余额字段和百分比窗口同时出现：

```ts
type AccountSnapshot = AccountBase & (
  | {
      mode: "balance";
      balance: {
        remaining: number | null;
        used?: number;
        total?: number;
        currency: string;
        unlimited?: boolean;
        expiresAt?: string | null;
      };
    }
  | {
      mode: "subscription";
      plan?: string;
      windows: Array<{
        kind: "session" | "weekly" | "monthly" | string;
        usedPercent: number;
        remainingPercent: number;
        resetsAt?: string | null;
      }>;
    }
);

interface AccountBase {
  id: string;
  displayName: string;
  plan?: string;
  status:
    | "ok"
    | "not-configured"
    | "unauthorized"
    | "rate-limited"
    | "unavailable"
    | "invalid-response"
    | "unsupported";
  fetchedAt: number;
  stale?: boolean;
}
```

例如余额型响应为：

```js
// GET /api/usage-stats/account?provider=<id>
{
  ok: true,
  account: {
    id: "relay-a",
    displayName: "Relay A",
    mode: "balance", // 或 subscription
    status: "ok",
    plan: "default",
    balance: {
      remaining: 2.0,
      used: 1.0,
      total: 3.0,
      currency: "USD",
      unlimited: false,
      expiresAt: null
    },
    fetchedAt: 1786723200000,
    stale: false
  }
}
```

`status` 建议固定为：`ok | not-configured | unauthorized | rate-limited | unavailable | invalid-response | unsupported`。余额和订阅可以共享 provider 外框、状态与刷新逻辑，只有 `balance`/`windows` 内容不同。

为避免一次性破坏现有客户端，可先保留 `/balance` 和 `/subscriptions`，让它们调用新的 registry；新客户端改用 `/account?provider=`，下一大版本再移除旧路由。

### 2. Account adapter registry

建议新增 `lib/accounts.js` 作为深模块，公开小接口：

```js
resolveAccountSpec(provider, pluginConfig)
queryAccount(spec, credentials, deps)
listAccountCapabilities(provider, pluginConfig)
```

内置 adapter：

```text
deepseek-balance
openrouter-balance
moonshot-balance
new-api-token
new-api-user-fallback
opencode-go
zai-token-plan
kimi-token-plan
minimax-token-plan
declarative
```

每个 adapter 只处理凭据解析、上游请求和归一化，不包含 UI 文案。现有 `balance.js` 与 `subscriptions.js` 可逐步成为 registry 的内部实现，而不是继续扩展两个平行入口。

OpenRouter 的账户 credits adapter 是特殊凭据边界：当前官方 `GET /api/v1/credits` 返回 `data.total_credits` 与 `data.total_usage`，且明确要求 Management Key。它默认使用独立 credential ref `OPENROUTER_MANAGEMENT_KEY`，不得复用 provider 的普通推理 API key；余额按 `total_credits - total_usage` 计算。普通 key 的 `/api/v1/key` 只反映单 key spending limit，不等同账户余额。[OpenRouter credits API](https://openrouter.ai/docs/api/api-reference/credits/get-credits) [当前 key API](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key)

### 3. 使用 Cordis config 绑定自定义 provider

Harness 官方支持 Cordis entry 的 `config`，并把配置作为 `apply(ctx, config)` 的第二参数传入；插件可导出 Standard Schema 做启动前验证。[Harness 配置教程](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/cordis-tutorial/05-config.md)

建议一期直接在 `cordis.patch.yml` 配置，不新增带写权限的浏览器设置 API。密钥仍只放 `~/.dsh/.credentials.yaml`，普通配置只保存 credential ref：

```yaml
- insert:
    - id: usage-stats
      name: dsh-usage-stats
      config:
        monitors:
          relay-a:
            providerId: relay-a
            adapter: new-api
            # 默认复用 relay-a 的 baseURL 与 apiKeyEnv
            usageBaseURL: https://relay.example.com
            # 仅旧实例 /api/user/self 回退需要
            fallbackCredentialRef: RELAY_A_MANAGEMENT_PAT
            fallbackUserIdRef: RELAY_A_USER_ID

          private-model:
            providerId: private-model
            adapter: declarative
            mode: balance
            request:
              path: /account/balance
              method: GET
              auth:
                type: bearer
                credentialRef: PRIVATE_MODEL_API_KEY
            extract:
              root: /data
              remaining: /available_balance
              used: /used_balance
              total: /total_balance
              currency: /currency
```

`providerId` 必须指向 Harness 中真实存在的 provider；启动时发现未知 provider、非法 JSON Pointer、绝对跨域 URL 或未知 adapter 应直接报清晰配置错误。

### 4. 声明式自定义提取器

一期只支持 JSON 响应和 GET：

```js
{
  request: {
    path,                 // 相对 usageBaseURL
    method: "GET",
    auth: { type, credentialRef },
    headers: { Accept: "application/json" }
  },
  extract: {
    root,                 // JSON Pointer
    valid,
    invalidMessage,
    plan,
    remaining,
    used,
    total,
    currency,
    divisor
  }
}
```

订阅自定义再增加 `items` 与每项的 `kind/usedPercent/remainingPercent/resetsAt` 指针。JSON Pointer 比任意 JS 更容易验证、测试和脱敏；计算只提供枚举操作，例如 `divide`、`remaining-to-used-percent`、`used-over-total-percent`，不接受表达式字符串。

### 5. 查询与安全边界

- 凭据通过 Harness `credentials.resolve(ref)` 在发送请求前作为数据注入，不写入脚本、配置回显、缓存或日志。
- 默认要求 HTTPS；仅显式 opt-in 才允许 localhost/private network。
- 默认同源；`path` 必须相对 `usageBaseURL`。不允许用户覆盖 `Host`、`Cookie`、`Authorization`、`Proxy-Authorization`、`X-API-Key`、`API-Key` 等敏感 hop/auth headers，也不接受在 URL 的 username/password 中内嵌凭据。
- `redirect: "manual"`，避免 30x 把 Authorization 带到未经校验的新 origin。
- 15 秒超时，限制响应体大小（建议 1 MiB），只接受 JSON；错误中不回显原始响应正文。
- `401/403` → `unauthorized`，`429` → `rate-limited`，超时/连接/5xx → `unavailable`，JSON/字段不符 → `invalid-response`。
- 缓存 key 使用 `providerId + accountConfigHash`。瞬时错误可保留上次成功值并标记 `stale: true`；鉴权失败不得用旧值伪装正常。

CC Switch 也区分瞬时传输失败和确定性失败：前者交给查询层重试并保留旧成功值，后者立即展示 `success:false`。[失败折叠](https://github.com/farion1231/cc-switch/blob/40d747c009bff6a6097d5094e57d205420d9b24c/src-tauri/src/services/provider/usage.rs#L53-L93)

### 6. UI

现有统一卡片可以继续使用：

- New API 与声明式余额：主值显示 `remaining`，次级显示 `used/total`、套餐名、到期时间；无限额度显示 `∞`。
- Kimi/Z.ai/MiniMax：复用订阅进度条，分别显示 5 小时和周窗口及重置时间。
- 颜色语义继续按已用率：低于 70% 正常、70–89% 警告、90% 及以上危险；这是 CC Switch 的现有规则。[百分比配色](https://github.com/farion1231/cc-switch/blob/40d747c009bff6a6097d5094e57d205420d9b24c/src/components/SubscriptionQuotaFooter.tsx#L46-L68)
- Provider picker 的每个选项携带 `accountMode/adapter` 元数据，不再由前端 `subscriptionIdFor()` 推断。
- 打开面板或切换选项时，浏览器只请求 `/account?provider=<selected>`。服务端独立在启动时及每五分钟刷新所有已配置账户与本地 Token 聚合；配置测试可先用命令行诊断脚本实现，后续再考虑只读预览 UI。

## 实施里程碑

### M1：协议与 New API

- 新增统一 account snapshot 与 adapter registry。
- 把现有余额/OpenCode Go/Z.ai 接入 registry，保持 wire compatibility。
- 实现 New API token endpoint、动态 `quota_per_unit`、unlimited/expiry。
- 客户端改为仅查询当前供应商。
- 为 200、401、429、404 fallback、无限额度、非默认 quota unit 编写离线 fixture 测试。

### M2：Token Plan

- 添加 Kimi、Z.ai/智谱、MiniMax adapter。
- Z.ai 可复用并收紧当前解析，避免出现两套实现。
- fixture 覆盖单窗口/双窗口、字符串数值、缺 reset、MiniMax 无周额度、百分比越界。
- UI 增加套餐标签和倒计时回归测试。

### M3：声明式 Custom

- 为插件导出 Config schema，支持 `monitors`。
- 实现请求策略、JSON Pointer 与有限计算操作。
- 加入 `--check` 或独立诊断命令，验证 provider/credential ref/config，不输出 secret。
- 覆盖恶意 redirect、跨域、私网、超大响应、非法 JSON、缺字段与配置 hash 缓存失效。

### 测试矩阵

| 层级 | 必测场景 |
| --- | --- |
| Registry | provider ID/显式 config 到 adapter 的绑定；未知 provider/adapter；显式配置覆盖默认推断。 |
| New API | token endpoint 200/401/429/404；404 且有 PAT 时 fallback；无 PAT 不 fallback；非默认 `quota_per_unit`；unlimited；expiry。 |
| Kimi | 单/多 `limits`；字符串数字；`limit=0`；缺 reset；401 与 5xx。 |
| Z.ai | 国内/全球 host；Authorization 无 Bearer；`unit=3/6`；旧套餐单窗口；缺失/异常 percentage。 |
| MiniMax | CN/global host；只取 `general`；有/无周额度；remaining-percent 反转；绝对 reset 字段及毫秒倒计时 `remains_time/weekly_remains_time`；业务错误。 |
| Declarative | JSON Pointer 成功/缺字段/类型错误；divisor；相对 URL；跨域、redirect、私网、超大响应和非 JSON 拒绝。 |
| Cache/error | config hash 隔离；瞬时错误保留 stale；401/403 清除正常态；并发切换时旧响应不能覆盖新 provider。 |
| Client | picker 只渲染当前 provider；balance/subscription union 两分支；∞、到期时间、进度条、各状态文案；切换只触发一个目标请求。 |
| Compatibility | 原 DeepSeek/Moonshot/OpenCode Go/Z.ai fixture 与 API 保持通过；OpenRouter 按当前官方 Management Key + credits 响应契约迁移。 |

### 版本建议

这不是简单增加一个 provider ID，而是新增公共 account protocol、Cordis config schema 和查询调度方式。建议作为 `0.2.0` 开发，不塞入安装修复版 `0.1.3`：

- `0.1.3`：只包含已完成的安装器 YAML 修复，便于用户安全升级。
- `0.2.0-alpha.1`：M1（统一协议、New API、客户端只查当前 provider、服务端后台全量缓存），先用真实但脱敏的 New API fixture/实例验证。
- `0.2.0-beta.1`：M2 + M3（Kimi/MiniMax、声明式 Custom 与 Config schema）。
- `0.2.0`：完成兼容回归、安全测试和文档后发布；旧 `/balance`、`/subscriptions` 暂保留并标记 deprecated。

## 主要风险与决策

| 风险 | 决策 |
| --- | --- |
| 上游非公开 endpoint 漂移 | 每个 adapter 独立、fixture 锁定、错误归类为 `invalid-response`，不要静默猜值。 |
| New API 部署自定义换算 | 从 `/api/status` 读取 `quota_per_unit`，500000 只作旧实例 fallback，并在诊断结果中标记 fallback。 |
| 同一 provider 同时有余额和套餐 | 配置显式选择 adapter/mode，不以 Base URL 猜测用户意图。 |
| 自定义请求造成 SSRF/密钥泄露 | 不执行 JS；默认 HTTPS+同源；手动 redirect；密钥只由 credential ref 注入。 |
| provider 数量增加导致后台请求膨胀 | 浏览器 endpoint 按 provider 查询；服务端按明确的后台监测契约每五分钟刷新所有已配置账户。上游限流会归类并使用 stale 缓存，不缩短刷新周期。 |
| 管理 PAT 与推理 Token 混淆 | New API 先用 token-scoped endpoint；管理 PAT 只作为显式 fallback，字段名和文档都标明用途。 |

## 建议的验收标准

1. 未配置新 monitor 时，DeepSeek、Moonshot、OpenCode Go、Z.ai 现有行为不变；OpenRouter 未提供独立 Management Key 时必须为 `not-configured`，不得发送普通推理 key。
2. 浏览器选择 provider A 时只调用 A 的 `/account`；服务端后台任务仍按启动即刷新、每五分钟全量刷新的监测契约查询所有已配置账户。
3. New API 默认只需现有推理 Token；非默认 `quota_per_unit` 的金额换算正确。
4. 所有浏览器响应、日志、错误和缓存均不含 API Key、PAT、Cookie 或原始上游正文。
5. 自定义模板无法跨 origin、跟随未验证 redirect 或访问私网，除非配置明确 opt-in。
6. 401/403、429、5xx/timeout、解析失败在 UI 中是不同状态；瞬时失败可显示带时间戳的 stale 旧值。
7. Kimi/Z.ai/MiniMax 的 5 小时与周窗口均有 fixture 驱动的百分比和重置时间测试。
