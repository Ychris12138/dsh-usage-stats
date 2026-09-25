# v0.3.4 release notes

`v0.3.4` is a DSH 0.1.7 compatibility and host-safety release.

## Highlights

### Current DSH compatibility

- Fixes the DSH 0.1.7 client icon export change with compatible aliases and a
  safe inline fallback, so the Usage Stats sidebar action continues to render.
- Discovers providers from the host registry as well as settings while keeping
  registry-only routes out of pricing and account inference.
- Keeps the usage panel responsive during persisted-session scans with bounded
  reads, one published aggregate snapshot, and conservative handling of
  unsupported or transient log-read failures.
- Preserves token folds while pricing identity changes trigger a cache rebuild.

### Pinned transport host safety

- Fixes #111 by deferring delivery of the policy-approved pinned address until
  request and socket error handling is installed, preventing synchronous
  connect failures from terminating the DSH host.
- Existing address/family pinning, SSRF policy, SNI, retry, and fail-closed
  semantics remain unchanged.

### Sidebar and panel polish

- Aligns the expanded sidebar footer action with the host layout rhythm.
- Uses the host panel surface token and preserves keyboard focus visibility in
  light and dark themes.
- Keeps the plugin sidebar-only; it does not inject composer or
  `conversation.input.*` UI.

## Compatibility validation

The release candidate was tested from an isolated tarball profile with
`@deepseek-ai/dsh@0.1.7-rc.2`: DSH started without loader errors, the Usage
Stats sidebar action and panel opened, provider switching worked, and the
`/api/usage-stats/providers` endpoint returned 200.

## Non-features

- No new provider adapter, pricing rule, billing semantics, or currency logic.
- No new account polling loop or composer integration.
- OrcaRouter remains an optional provider integration; its pricing remains
  unknown unless a supported account response provides data.
