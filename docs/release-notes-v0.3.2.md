# v0.3.2 release notes

`v0.3.2` is a focused maintenance release for current DSH session compatibility and lower steady-state usage aggregation overhead.

## Highlights

### Current DSH Session API compatibility

- Fixes #95 for DSH builds where the public `Session.events` array has been replaced by `seq` and `snapshotEvents()`.
- Current DSH sessions now use the formal `seq` / `snapshotEvents(fromSeq)` API and continue folding only the live event tail.
- Older DSH session objects without `snapshotEvents()` retain the legacy `events` fallback.
- Compatibility is capability-based rather than tied to a DSH version string.
- Preserves live-log shrink recovery and conservative live/persisted refolding semantics.

### Lower usage polling overhead

- Fixes #94 by separating high-frequency UI usage reads from persisted archive refreshes.
- Ordinary `/usage` requests fold live-session tails and reuse cached persisted aggregates instead of enumerating every archived session.
- Persisted archive scanning remains on the existing background refresh path and explicit export paths.
- Unchanged collections no longer rebuild global aggregates or rewrite `usage-stats-cache.json`.
- Persisted sessions with unchanged revision tokens perform no event reads.
- A changed persisted revision still uses the existing incremental cursor logic, with full refolding retained for truncation or rewrite recovery.
- Scan-mode single-flight guarantees that a required full persisted refresh cannot be satisfied accidentally by an in-flight live-only request.

## Compatibility and non-features

- No frontend polling interval change and no additional timer or polling loop.
- No pricing-rule or billing-semantics changes.
- Pricing/provider fingerprint changes still invalidate and persist derived billing state safely.
- No private JSONL/zstd reader or plugin-owned persistence index.
- No attempt to optimize live-to-persisted transitions by trusting the previous live fold.
- No DSH `sessionProjectionCache` migration or modification.
- No cold-session eviction or bounded-cache redesign.
- No provider or composer UI changes.
- No #84 quota-precision change and no #93 feature work is included in this release.
- JSONL suffix reads remain an upstream DSH concern; a changed large archive may still require the host persistence backend to decode more data than the logical suffix.
