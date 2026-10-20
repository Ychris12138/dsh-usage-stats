# Providers Hub 配套余额服务

这里提供 PR #144 所需的宿主侧实现，不通过浏览器 RPC，也不读取另一个插件的凭据文件。

- 官方源码：<https://gitee.com/iJetLi/deepseek-harness-codearts>
- 精确基线：`4c428487bd75e0a02d7b4faa789e456ff44955e0`
- 配套本地提交：`45b889e507cd0ee18503996372c69bd4f5cff3e2`
- 补丁：`credit-balance-service-4c42848.patch`
- 交付内容：余额投影服务、真实宿主注册、公共类型导出、28 项投影测试、3 项真实 Cordis 接线测试及服务文档。

该源码基线的版本是 `0.2.1-rc.2`；当前公开 npm 包是另外的 `1.9.261020`。不要把这个源码补丁直接应用到 npm 编译产物。两者目前均未由上游正式发布 `creditBalance` 服务。

另附 `credit-balance-runtime-1.9.261020.patch`，仅适用于 SHA-512 校验通过的官方 npm `1.9.261020` 解包目录。它将同一投影服务接到该发布包已有的余额编排，并生成私有候选版本 `1.9.261020-credit-balance.1`。它不修改账号池、凭据文件或供应商协议，也不直接修改任何已安装 profile。

## 复现

在独立的官方源码 checkout 操作，按该仓库 AGENTS.md 进行开发：

```sh
git switch --detach 4c428487bd75e0a02d7b4faa789e456ff44955e0
git apply --check /absolute/path/to/credit-balance-service-4c42848.patch
git apply /absolute/path/to/credit-balance-service-4c42848.patch
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build:all
pnpm exec vitest run tests/unit/credit-balance-service.spec.ts tests/unit/credit-balance-wiring.spec.ts
```

然后在 Usage Stats 的 PR #144 分支运行：

```sh
npm run check
npm test
npm run test:providers-hub -- /absolute/path/to/built/providers-hub
```

跨仓联调加载真实 Cordis、真实宿主余额分派和真实 Usage Stats 消费端，只替换供应商取数。覆盖服务晚加载、移除/重载、原生 MiniMax 路由隔离、多账号部分失败、stale 回退、空账号池和导出脱敏。它不启动浏览器、不访问真实供应商、不读真实账户。

### 验证当前 npm 发布包

在一个新的独立目录下载并解包 `dsh-providers-hub@1.9.261020`，确认 registry integrity 为：

```text
sha512-ivqW18GqjcVdBhfTgNIWhLmOxCg3F+3kLKJzsHqXtK4eYSYSfgY0wdWZUdEjS+VRouJ30L5JOy2dpSaTjb5rJQ==
```

对解包的 `package/` 目录应用 runtime 补丁，保留全部既有运行依赖和同版本 Cordis peer：

```sh
git apply --check /absolute/path/to/credit-balance-runtime-1.9.261020.patch
git apply /absolute/path/to/credit-balance-runtime-1.9.261020.patch
npm pack --ignore-scripts
```

对新 tarball 再次解包后运行同一跨仓测试。源码候选包和当前 npm 版候选包都已通过这一步。补丁保留插件包名，只修改余额服务接线、服务实现/类型、包的候选版本标记和说明；不冒充上游官方发行。

## 验证结果与边界

- 宿主与客户端完整构建、宿主类型检查、测试类型检查、新增 31 项测试均通过。
- 上游完整测试共 9,880 项：9,853 通过、16 失败、11 跳过。未修改的官方基线复现完全相同的 16 项失败，分布在 AStudio 平台路径、会话 snapshotEvents 依赖及 macOS 的 127.0.0.2 网关绑定用例。不能称为上游全量测试全绿。
- 两个本地候选包分别为 `dsh-providers-hub@0.2.1-rc.2.credit-balance.1` 与 `dsh-providers-hub@1.9.261020-credit-balance.1`。都保持原包身份并标记 `private: true`，仅供隔离验收，不是官方发行或 npm 发布。
- OpenCode 的本地可用通道数被明确排除，避免当成 Go 订阅额度。
- 正式支持仍需上游合并/发布服务，并在真实隔离 DSH profile 中用明确选中的账户对账。本轮没有这种真实账户验收。
