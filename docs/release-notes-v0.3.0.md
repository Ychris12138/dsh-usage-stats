# v0.3.0 release notes (release candidate)

`v0.3.0` turns dsh-usage-stats from an account/Token dashboard into a route-aware usage and cost observability layer while preserving the v0.2.x credential and loopback security boundaries.

## Highlights

- A shared provider identity policy keeps route, provider family, account adapter, and pricing eligibility separate. Unknown/custom gateways remain unknown unless explicitly configured.
- The Current Session Pill shows the active route's account state and event-derived current-session cost beside the composer, and opens the existing provider panel when clicked. It is enabled by default and can be disabled with `display.currentSessionPill: false`.
- Account health now includes provenance, stale state, last attempt/success, age, bounded diagnostics, configurable refresh intervals, and a true automatic-refresh off switch.
- DeepSeek historical pricing is matched by exact model, route eligibility, event time, and Shanghai pricing windows. Daily/monthly budgets are optional and fail closed.
- New API balance display respects the instance's USD/CNY quota settings. Unsupported display types and invalid CNY exchange rates do not masquerade as money.
- Daily CSV, session CSV, and versioned JSON exports use explicit secret-free projections, preserve Unicode, escape CSV safely, and omit incomplete cost amounts.
- The account panel remembers its last valid provider in namespaced browser localStorage and falls back safely if that provider is removed.

## Cost accuracy statement

All monetary values are **estimates**, not invoices. A sample is priced only when its provider route is eligible for an official catalog, its model matches exactly, its event timestamp selects a known historical rule, every reported token bucket has a price, and the result has one supported currency. Custom gateways, subscriptions, unknown models, ambiguous historical identity, unpriced cache writes, and mixed currencies return no estimate. The plugin does not call an FX service and does not reinterpret old usage using today's route or price.

## Upgrade notes

- Existing v0.2.10 configuration remains valid. The new display setting, budgets, and refresh controls are additive and default to the previous behavior.
- Older usage-cache schemas are invalidated and refolded from authoritative session events. Malformed cache JSON is ignored and rebuilt; it must not block DSH startup.
- Existing account monitor configuration is normalized without writing credentials or inserting new monitor entries.
- Browser provider selection is local UI state only; it creates no endpoint and no server-side setting.

## Release status

This document describes the `v0.3.0` release candidate. The package version remains `0.2.10` until maintainer review and the complete RC checklist pass. npm publish, tag creation, GitHub Release creation, Pages verification, and Desktop Market installation are separate final release steps.
