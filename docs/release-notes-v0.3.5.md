# v0.3.5 release notes

`v0.3.5` is a DSH 0.2 Desktop account-compatibility and provider-safety release.

## Highlights

### DeepSeek Account on DSH 0.2 Desktop

- Adds a separate `deepseek-account` source backed by DSH's Host-owned account
  service while preserving the existing API-key DeepSeek path for older Harness
  versions and explicit API-key routes.
- The plugin consumes only safe account state and balance operations. Raw
  account tokens, Cookies, PKCE material, and Host-only token resolution never
  cross into the browser/plugin payload.
- Recharge and granted wallets are normalized per currency. CNY and USD are
  never combined into a synthetic total.
- Account-login state is refreshed on UI reads, so signing out does not leave a
  stale balance visible; signing back in restores the account view.
- Pricing remains deliberately unknown for the account-login route until route
  history/model-pricing semantics are explicitly validated.

### MiniMax regional Coding Plan safety

- Fixes the MiniMax Coding Plan quota path for CN/global regional credentials.
- Known CN and global routes are pinned to their own hosts, including route-id,
  provider-base-URL, and credential-ref signals.
- Cross-region retry is allowed only when the route has no region signal and
  the first region explicitly rejects the credential with MiniMax business
  status 1004/2049.
- Explicit `usageBaseURL` remains authoritative and never falls back.
- Two-region credential rejection now reports `unauthorized` instead of
  masquerading as an unrecognized quota response.
- PR #122 was validated by its contributor against a real CN Coding Plan
  account and returned two quota windows.

### Usage and packaging polish

- Adds the official DeepSeek peak/off-peak tariff countdown with transition-
  boundary refresh and fail-closed behavior for custom relays.
- Shows recent complete per-session cost estimates in the existing sidebar
  panel while omitting incomplete or mixed-currency amounts.
- Removes the obsolete `@deepseek-ai/dsh-client-runtime` client activation
  entry while retaining the locale and UI-primitives dependencies used by the
  plugin.

## Compatibility validation

The release candidate was accepted in a real DSH Desktop 0.2.x environment on
2026-10-01. The maintainer verified that DeepSeek Account appears as a separate
provider, signed-in balance renders without an API-key warning, signing out
immediately removes the prior balance on the next UI read, and signing back in
restores the account view.

The existing DSH 0.1.x API-key path remains supported through capability
detection rather than a hard version switch. Automated coverage also retains
the DSH 0.1.7 provider-registry, icon-alias/fallback, persistence-read, and
sidebar-only compatibility paths introduced in v0.3.4.

## Security boundaries retained

- The plugin remains sidebar-only and registers no `conversation.input.*`
  composer integration.
- Account credentials remain Host/server-side and are not included in exports,
  client responses, fixtures, or diagnostics.
- MiniMax credentials with a known regional identity are never sent to the
  other region.
- Unknown pricing, malformed quota responses, mixed currencies, and incomplete
  cost estimates continue to fail closed rather than guessing values.
