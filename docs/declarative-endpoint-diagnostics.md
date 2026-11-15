> Historical investigation: #163 was merged on 2026-11-06. The original 0.3.5/0.3.7 observations below describe the pre-fix state; real-host acceptance remains open.

# Declarative monitor endpoint diagnostics — #162

Prepared on 2026-11-05 against main `fb2bf64a3e619b6a3bfe11088e968901ca23f787`.
References [Issue #162](https://github.com/Ychris12138/dsh-usage-stats/issues/162).

## Confirmed local failure and scope

The reporter used plugin 0.3.5 with DSH 0.2.1-rc.5. Current main / 0.3.7 still has the relevant diagnostic gap: a registered route can be visible without settings-backed connection fields. `configuredProviders()` uses that registry entry for identity only. If a declarative monitor lacks an explicit `usageBaseURL`, `customURL()` can receive an undefined base URL. The URL constructor throws before transport and the account snapshot previously reports `unavailable` / `unknown` with no attempt timestamp.

This failure was reproduced using the real discovery and account service with synthetic credentials and transport. It matches one possible explanation for #162, but does **not** prove what connection metadata the reporter's installed Harness exposes. The Draft must not be presented as completed real-account acceptance.

The patch changes the local diagnosis for balance and subscription modes:

| Preflight result | Status / reason | Transport |
| --- | --- | --- |
| No effective endpoint, including a blank provider base URL | `unavailable` / `monitor-base-url-missing` | Not called |
| Effective endpoint or nonempty provider base URL cannot be parsed | `unavailable` / `monitor-base-url-invalid` | Not called |
| Required credential absent | Existing `not-configured` / `missingCredentials` | Not called |
| Different provider/monitor origins without opt-in | Existing `blocked` / `blocked-network` | Not called |

Both new reasons are fixed allowlisted codes, rendered with Chinese and English configuration guidance. No URL parser message, raw config, resolved credential, or additional logging is introduced. The invalid-provider check remains active even when an explicit monitor endpoint is present; silently ignoring that origin would weaken isolation. Existing HTTPS, DNS/IP, redirect, query-auth and response-echo guards remain in place.

For a first preflight failure, `lastAttemptAt` and `lastSuccessAt` remain `null`. They must not be fabricated to imply a request. Existing same-binding history/stale retention rules still apply after earlier requests. Startup continues to reject invalid explicit `usageBaseURL` values through the existing config validator; these runtime reasons cover missing or malformed discovered provider metadata.

## Explicit configuration to review

Merge into the **existing** usage-stats plugin entry, substituting only the public endpoint and credential reference name. The example names are synthetic; no real service is contacted by the tests.

```yaml
monitors:
  custom-quota:
    adapter: declarative
    mode: subscription
    usageBaseURL: https://quota.example.com
    request:
      path: /quota/windows
      auth:
        type: bearer
        credentialRef: CUSTOM_QUOTA_API_KEY
    extract:
      root: ""
      items: /windows
      kind: /kind
      usedPercent: /usedPercent
      remainingPercent: /remainingPercent
      resetsAt: /resetsAt
      plan: /plan
```

The path starts at the origin root; a provider base URL ending in `/v1` does not prepend `/v1` to `/quota/windows`. If a provider base URL is readable, its origin must match the explicit usage endpoint unless a separately reviewed cross-origin opt-in exists. Do not loosen that policy as a troubleshooting step.

## Regression and acceptance boundary

- The new account regression fails on unmodified main with actual reason `unknown`; it passes the new endpoint assertions after the patch.
- Registry-only discovery → real account service → cache/health/provider views covers both balance and subscription, blank and invalid endpoints, explicit endpoint recovery, missing credentials, cross-origin denial and secret-free snapshots.
- A registered HTTP handler regression uses the real service and discovery, replacing only credentials and upstream transport with fixtures. `/account` and `/providers` expose the fixed diagnosis; adding the explicit endpoint invalidates the failed binding and permits the synthetic request.
- Client rendering covers both modes and both new codes, rejecting arbitrary diagnostic text and excluding raw error fields. Existing account/network tests remain enabled.
- Local check, client, server, bundle and installer checks passed. The full local account suite hit the existing synchronous pinned-connection subprocess timeout; an unmodified baseline hit the same failure. This is not reported as a local full-suite pass. Exact-commit GitHub check/full-suite results belong in the PR validation record.

Before treating #162 as resolved, review the exact Draft commit and obtain sanitized installed-Harness evidence. Passing fixtures does not prove a real DSH metadata shape, real request, account quota, or dashboard reconciliation. No version, release tag, npm publication or market entry changes are included.

## 待发送的回复草稿（未发表评论）

已在当前源码复现一条会导致相同表现的路径：注册表仅提供 route id、monitor 未配置 `usageBaseURL` 时，地址构造会在发请求前失败，并被归为 `unknown`。草案增加了固定原因码和配置提示，但目前尚未确认这就是你环境中的根因。

如后续协助验收，最少可提供：实际安装的插件版本或提交 SHA、DSH 版本、是否已在原有 monitor 中显式配置 `usageBaseURL`（只需布尔值），以及重新刷新后的脱敏 `status`、`reason`、`missingCredentials`、`lastAttemptAt`、`lastSuccessAt`。若查询成功，再附是否观察到对应额度路径请求的布尔结果与响应状态码即可。请勿提交 API Key、Cookie、Authorization、完整配置、凭据文件或 HAR。不要为排查关闭同源或网络隔离。

该草稿保留供维护者审阅，没有向报告人发送催办信息。
