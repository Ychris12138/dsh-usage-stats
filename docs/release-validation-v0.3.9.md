# v0.3.9 候选复核：2026-11-27

## 对象与变更边界

运行时和 npm 打包输入来自 `92710890b017c7ea2b56535c7cb22498cfa523f2`（树 `fc9613ecc05608721ddc95b0ee8b9c9023da373e`），下载快照的 Git 树与 GitHub 完全一致。本次仅新增客户端行为回归和此证据记录，不改变发布包文件。后续若修改任何打包输入，应重新生成哈希并安装验证。

维护者已在 11 月 26 日合并 #175 / #177；主线 `c9e1518ee93328929601208c1c4f4d954792f1b9` 的 [CI](https://github.com/Ychris12138/dsh-usage-stats/actions/runs/45754851285) 成功。当前候选用容量测量替代 #177 的 wrap 覆盖；该历史修订不能作为新布局的验收结论。#133 已关闭且未合并，仍缺上游响应 usage 契约。

## 自动验证

- 原候选的 [精确提交 CI](https://github.com/Ychris12138/dsh-usage-stats/actions/runs/45757611919) 成功，job 明确包含 `npm ci`、`npm run check` 和 `npm test`；新增回归的 CI 需看本 PR 最新 checks。
- 本地 `npm run check`、客户端、overlay、服务端、导出、provider identity、OrcaRouter、pricing、billing、balance、subscriptions、CodeArts、installer、Ark、千问及 follow-session 测试通过。
- 本地完整 `npm test` 在已有 `test-accounts.mjs` 的 pinned-fetch 同步异常子进程用例超时（`spawnSync ETIMEDOUT`），不能记为本地全套通过。原候选 GitHub Actions 同一套测试成功。新增账户场景在本地运行至此之前已通过；没有为消除超时而跳过或改写测试。
- 新增注册槽位的 React 行为回归：默认关闭且单入口，面板显式启用，快捷键切换，输入框/可编辑内容/重复及已处理按键不切换，overlay 卸载后的侧栏回退，重新挂载及新模块恢复偏好，可选槽位缺席，以及插件释放快捷键监听。
- 在可丢弃副本中故意移除 overlay 缺席时的侧栏回退，新回归按预期失败，确认能捕获入口丢失问题。

以上是模拟宿主和协议回归，不是 DS Bot、真实 DSH 事件或真实账户验收。

## 打包与隔离安装

命令：`npm pack --json --ignore-scripts`。44 个包内文件逐字节匹配对应源码；包大小 186608 字节。

- 文件：`ychris12138-dsh-usage-stats-0.3.9.tgz`
- SHA-256：`eebbe9e0339e3b05f270a66dc9bcbfd3b2f78cdd2143e2c25f3f5acf4a4a3e29`
- integrity：`sha512-/FjcVxQhjrlSQo5Epf+XwLX+AnvA6og2QeSbZqAxSxgN2656pDL9MBeGbXjrU+vIZW+qG0pPGt+GDxa0ltwaWQ==`

隔离目录分别执行离线 npm 全新安装，以及公开 0.3.8 包升级到候选；旧包先按 registry SHA-512 验证。两条路径均通过模块导入、独立 `DSH_HOME` 安装器重复执行及 `--check`；21 个安装器实际复制的文件逐字节匹配，Cordis patch 中仅有一个插件条目。升级路径先安装 0.3.8 到 profile 再升级。未启动真实宿主、未验证账户。

本记录和 smoke 脚本不在 npm 的 files 白名单内；加入它们后应再次确认 tarball 不变。

## 外部条件与最小验收

- 11 月 27 日 registry 的稳定版仍是 0.3.8，未发现精确 0.3.9。发布前继续保留主线和市场稳定版。
- Providers Hub `2.37.261126`（11 月 26 日发布）下载完整性通过；1351 个归档文件中未发现 `creditBalance`、`supportedProviders`、`creditsBalances` 标识。版本升级本身不能证明 #128 的上游服务已发布，也没有真实双插件验收。
- #129 / #130 没有新增脱敏验收信息；代码和回归保留显式引用优先、CN 专用 key 优先于旧 key、CN/global 隔离及失败不换 key 重试的规则。历史用户成功截图仍不能补齐下列证据。

待发验证内容（本次未评论或发送）：

1. #129：插件精确 SHA、DSH 版本/profile；确认已撤除 `credentialRef` 和 provider `apiKeyEnv` 显式绕过；仅提供 account.status、missingCredentials 的字段名列表及实际 quota URL 的 origin/path，确认 CN 请求进入 `https://open.bigmodel.cn/api/monitor/usage/quota/limit`。不要提供 key、header、完整配置或 HAR。
2. #174：精确候选 SHA、DS Bot/DSH 版本/profile、版本来源和 account.status；确认默认入口、显式悬浮选项、Alt/Option+Shift+U、重启偏好、槽位缺席时的回退。只记录可见性、操作结果及脱敏状态，不记录余额金额。
3. #176：宿主版本、插件组合和顺序；一个/两个/三个入口、宽/窄侧栏、动态增删和卸载结果。自动容量测试不能证明实际 CSS、鼠标点击和视觉遮挡。
4. #128：带精确已发布 Hub 版本的服务契约和真实双插件结果，保留 route 的地区归属；#133 若恢复工作，需要上游已发布的响应 usage 事件及真实搜索/重启记录。

最终发布还需候选 Web/DS Bot 账户结果、#162 原环境、OpenCode Go / 方舟真实订阅等已有门槛。此记录不批准合并、发布、打 tag 或切换市场。
