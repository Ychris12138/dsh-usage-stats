# v0.3.3 release notes

`v0.3.3` is a focused compatibility and correctness hotfix for current DSH persisted-session handling and declarative balance extraction.

## Highlights

### Current DSH persisted-session compatibility

- Fixes #99 and #102 for current DSH builds using the handle-based session persistence API.
- Persisted sessions are enumerated through `list()` and read through `open(id, "read")` / `handle.read()`, with handles closed after use.
- Current `{ header, revision }` listing entries are normalized to their real session ids instead of being treated as bare headers.
- The modern persistence path no longer calls the removed `readFrom()` API.
- Older DSH builds retain the existing `listSnapshots()` / `readFrom()` fallback.
- Compatibility remains capability-based rather than tied to a DSH version string.
- Settled/disposed sessions can be reconciled promptly without double-counting sessions already covered by a persisted scan.
- Failed persisted reads preserve the previous folded state so a later scan can reconcile safely.

### Declarative balance remaining calculation

- Fixes #101 when a custom declarative balance exposes `used` and `total` but no explicit `remaining`.
- Explicit numeric `remaining`, including zero, keeps precedence.
- Otherwise the plugin derives `remaining = max(0, total - used)`.
- Derived values are calculated in raw units before applying the configured divisor.
- Explicit malformed `remaining` values still fail closed rather than being hidden by fallback derivation.
- Incomplete responses no longer treat `total` as `remaining`.

## Compatibility and non-features

- No pricing-rule or billing-semantics changes.
- No account refresh or frontend polling changes.
- No cache schema migration.
- No provider additions.
- No dark-theme UI changes (#98).
- No DeepSeek peak/off-peak countdown or per-session billing UI (#100).
- No Volcengine Coding Plan support (#74).
- No additional MiniMax compatibility change is claimed in this release.

