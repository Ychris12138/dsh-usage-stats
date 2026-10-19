# v0.3.6 release notes

`v0.3.6` adds the Command Code account adapter and quota normalization on top of
the v0.3.5 DSH 0.2 compatibility and provider-safety release.

## Highlights

### Command Code plans and credits (experimental)

- Detects Command Code route ids and `*.commandcode.ai` provider hosts without
  importing or modifying the provider plugin.
- Reads the provider's `COMMANDCODE_API_KEY` (or an explicit monitor
  `credentialRef`) and normalizes the upstream five-hour, weekly, and monthly
  quota windows together with the credits balance.
- Keeps monthly-window denominators tied to the upstream monthly pool fields;
  missing or ambiguous values remain unavailable instead of being treated as
  zero or inferred from unrelated aggregate credits.
- Preserves route-aware pricing safety: Command Code is a reseller route and
  remains unpriced even when its model name resembles an official provider.
- Keeps upstream failures and malformed values fail-closed with safe reason
  codes; credentials and raw upstream responses do not cross the account
  snapshot or browser boundary.

The adapter uses unpublished `/alpha/*` Command Code endpoints and a client
version contract used by the provider's CLI. No real Command Code account was
available for this release candidate, so live upstream acceptance is **not
tested** and is not a guarantee of endpoint stability.

## Compatibility and scope

- The v0.3.5 DeepSeek Account, MiniMax regional safety, sidebar-only client,
  cost/budget, export, and migration behavior remains unchanged.
- No pricing catalog, session ledger, refresh policy, UI injection point, or
  package identity was changed outside the Command Code adapter and release
  metadata.
- Open PRs for Z.ai CN, web-search response events, and CodeArts remain outside
  this release until their respective upstream or real-environment acceptance
  conditions are met.

## Security boundaries retained

- Credentials remain server/host-side and are never included in exports,
  browser responses, fixtures, or diagnostics.
- Unknown pricing, incomplete quota data, mixed currencies, and malformed
  upstream responses continue to fail closed rather than guessing values.
- The plugin remains sidebar-only and does not register any
  `conversation.input.*` composer component.
