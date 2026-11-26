# DS Bot 兼容性跟进（#174）

2026-11-21，依据 [报告 #174](https://github.com/Ychris12138/dsh-usage-stats/issues/174) 准备。报告环境是 DS Bot 0.3.8、Windows x64、DSH 0.2.2-rc.1、插件 0.3.8、ds-bot profile。

## 账户版本来源

当前主线已通过 #171 为没有 DSH_CLIENT_VERSION 的宿主提供版本回退，但不读取 clientModules.graph().release.version。此次修订在显式 DSH_CLIENT_VERSION 之后、其它环境变量和安装清单之前读取该字段，只接受受限长度的可打印版本字符串。服务缺席、返回异常或字段无效时继续使用已有回退。该服务是可选的，不新增激活依赖，也不缓存其版本，以便服务晚加载或替换后重新读取。

上游 [ClientModuleRegistry](https://github.com/deepseek-ai/deepseek-harness/blob/ca33fd6843b205e279c7ccb6cb73a472c78f5760/packages/client/modules/src/index.ts) 将 release 定义为宿主发布身份，并通过 graph() 返回。修订不读取或传递 graph 中的配置、令牌或其它字段。

服务器回归验证版本优先级、宿主版本变化、异常回退，以及原有 locale/timezone 和账户脱敏行为。用扩展测试运行未修改主线，可复现版本来源选择不符。测试只使用虚构宿主服务，不能确认 DS Bot 的真实余额。

## 侧栏入口：待验证的接入方案

报告指出 DS Bot 隐藏原生 sidebar.footer.action 的祖先容器，插件按钮即使存在也没有可见尺寸。优先让自定义宿主公开可见槽位，继续使用插件的单一入口；若需要插件兼容模式，可设计显式开启的独立入口，再确定位置、遮挡策略和键盘访问。不要直接依赖报告中的压缩类名，也不因一次零尺寸测量就在 body 追加第二个入口：折叠、启动和布局切换也可能短暂隐藏容器。

下一步最小脱敏验证：插件提交 SHA、DS Bot/DSH 版本和 profile、入口可见性与点击结果、版本来源及 account.status。只提供状态；不需要余额金额、凭据、Cookie、Authorization 或 HAR。当前修订仅解决版本来源，不宣称解决隐藏侧栏。

## 尝试时间的含义

未发起 getBalance 时保留 lastAttemptAt 的现有含义，不把一次本地预检改写成上游查询。需要区分预检与查询时应另行设计安全的判定原因字段；不要仅为了让时间非空而伪造请求记录。此次修订没有改变账户健康时间的定义。
