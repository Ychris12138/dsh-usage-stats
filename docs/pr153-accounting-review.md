# Seeded sessions and compaction accounting

The integration preserves contributor PR #153 and the compaction/read-safety fixes
from #154. Review on 2026-10-29 uses DSH source
[`f3803c9`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/session/src/index.ts)
and the [handle contract](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/docs/subsystems/persistence.md).

## Accounting policy

- Read exact `inheritedEventCount` from the live Session or the read handle paired
  with its body. A tagged `session/end-seed` event also states the cut. Timestamps,
  calendar days and `parentSession` alone do not prove inherited ownership.
- Keep normalized usage evidence in each session ledger: sequence, time, sample
  kind/turn-step, exact route/model, buckets and cost derivation. Only SHA-256
  aliases of this normalized evidence are stored, never prompts, headers, message
  bodies or credentials. A replacement retains earlier aliases so copied chunks
  can match the corrected final sample.
- Project matching inherited records once across sessions, preferring an original
  owner; when only copies survive, choose a deterministic surviving owner. A
  missing/partially compacted parent cannot erase a unique historical sample.
  Independent own calls remain distinct even if their evidence is identical.
- Project aggregate tokens, billing and per-session/export rows together. Source
  ledgers are retained so removal/reappearance of an original can change ownership
  without deleting or duplicating the only surviving usage.
- Compaction IDs have a separate replacement ledger; interleaved assistant
  chunk/final samples and corrected compaction summaries do not double count.
- Empty/failed full reads keep cached folds and the old revision for retry.
  Schema 10 refolds readable older sources and preserves unavailable aggregates.

## Validation and limits

Synthetic server regressions cover modern live forks without parent IDs, exact
read-handle metadata, child-before-parent reads, partial same-day parent history,
equal timestamps, multiple/nested orphan copies, original removal, inherited-cut
changes, independent equal own calls, corrected sample aliases, restart, cache
migration, empty full-refold retry, and compaction interleaving/cost replacement.
The previously failing examples are 137 (not 242), 12 (not 17), and 22 (not 12).
Unchanged stored revisions remain read-free. Cache evidence excludes raw bodies.

Older Hosts without an exact cut keep their original fold behavior: duplicates
may remain rather than discarding usage using a guessed wall-clock boundary.
Older unreadable aggregates lack sample evidence, so they are retained as opaque
fallbacks and cannot be retrospectively deduplicated. Partial sources whose
normalized sample identities cannot be matched are also retained. The cache now
stores normalized per-sample evidence and can be larger than prior aggregate-only
caches. Back up the old cache before a production upgrade; downgrading to a plugin
that does not understand schema 10 may require rebuilding readable source logs.

Automated fixtures establish these contracts, not a real account's billing
reconciliation or exact agreement with a provider console. No real credentials
were accessed for this review. Search response usage (#133), personal Ark account
acceptance (#143), and the unshipped Hub balance service are separate gates.
