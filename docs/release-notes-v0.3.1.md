# v0.3.1 release notes

`v0.3.1` is a small maintenance release focused on an optional OrcaRouter integration, lower UI intrusion, and two focused correctness and usability fixes.

## Highlights

### OrcaRouter optional integration

- Adds an optional, explicit OrcaRouter provider preset with `orcarouter/auto`.
- Never mutates settings at startup and never embeds or stores an API key value.
- Fresh installations expose a user-triggered Add flow; existing OrcaRouter provider settings remain untouched.
- Reads current wallet data from `/v1/balance`, with the compatible billing-summary fallback retained for older deployments.
- Includes paid, free, and promotional credit only when the upstream response provides valid values.
- Keeps OrcaRouter pricing unknown (`null`): an OrcaRouter route never inherits DeepSeek, OpenAI, or another upstream provider's prices.
- Keeps the sponsored-integration disclosure compact in the README and provider selector.

### Sidebar-only UI

- Removes all dsh-usage-stats components from `conversation.input.*` and the composer toolbar. Permission, Model, Context, and Submit remain entirely host-owned.
- Keeps Usage Stats available through `sidebar.footer.action` and the existing sidebar panel.
- Continues to accept legacy `display.currentSessionPill: true` and `false` configuration for compatibility; the setting is now a no-op and renders no composer UI.

### Persisted-session fallback performance

- Fixes #57 through #58: unchanged persisted fallback logs no longer refold from sequence 0.
- Keeps appended events incremental.
- Still detects truncation or rewrite and performs the required full refold.

### Recent usage list polish

- Fixes #75 by right-aligning Last 14 days token values.
- Lets the date column shrink and ellipsize in narrow panels instead of forcing a fixed width.

## Compatibility and non-features

- No OrcaRouter automatic pricing and no second pricing engine.
- No new client polling loop and no composer UI.
- No #84 quota-precision behavior change is claimed in this release; #84 remains open for clarification and retesting.
- No client price table, fallback unknown-model pricing, Beijing-tariff recomputation, independent account polling, or blended-price sidebar logic from #88 is included.
- No changes to historical pricing semantics and no credential migration.
