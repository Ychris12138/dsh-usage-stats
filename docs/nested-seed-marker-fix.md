# Nested inherited-marker correction (preparation, 2026-10-30)

Published 0.3.7 at `fb2bf64a3e619b6a3bfe11088e968901ca23f787` uses the
first tagged `session/end-seed` event to overwrite the session's inherited cut.
A nested fork copies ancestor markers before appending its own marker, so this
can turn copied usage into an independent own call and count it again.

Reproduction with synthetic events: parent owns 5 tokens at seq 0; child copies
that event, appends its tagged marker at seq 1, and owns 7 tokens at seq 2;
grandchild copies the child's log, appends its own marker at seq 3, and owns
11 tokens at seq 4. Its authoritative inherited offset is 3. Version 0.3.7
overwrites it with 1, yielding **30 instead of 23 tokens**.

The upstream [Session constructor at
f3803c9](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/session/src/index.ts)
requires the inherited count to identify the **final inherited marker** and
explicitly retains ancestor markers in the copied prefix. Ordinary resume
markers without `data.inherited: true` do not define a fork cut.

The fix selects the final tagged marker. Regressions cover live Sessions,
persisted handles carrying the exact offset, marker-only compatibility,
unchanged collection, restart, and migration of an already incorrect schema-10
cut at an unchanged source revision. Existing source-evidence matching,
compaction correction, attribution and export projection remain intact.

Schema 12 requests a readable-source refold, because schema-10 caches can already
contain a wrong cut and otherwise skip the unchanged revision. Schema 11 is
reserved by the separate, unpublished search-event Draft #133. A failed or empty
source read preserves its existing aggregate; it cannot repair a boundary whose
source remains unavailable. No real account reconciliation is claimed.

This branch changes neither package version nor any published artifact, npm tag,
Git tag or market entry. Before release, review exact-head CI and the schema
migration, then coordinate a separately authorized patch release. Once integrated,
#133 must be replayed onto the accepted main and use a schema newer than 12;
its missing upstream producer and persistence acceptance remain independent gates.

The audit also verified the existing 0.3.7 npm tarball's registry integrity and
SHA-256 `eda01d9907cf9a7f98399b645f39d76ffa3833390d0bafb0122d59a9a2f2fc11`,
all 36 packed files against the frozen source, annotated tag target, and the live
market's exact version. This is a code defect in that verified package, not an
artifact mismatch. Main exact-head CI passed before the new regression existed.
