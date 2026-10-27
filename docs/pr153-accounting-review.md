# PR #153 accounting review — 2026-10-27

This preparation branch builds on contributor head
`e51c8c60ecbb1e02ca907fce594634ba78758252`. It preserves that history and
adds two independently reproduced safety fixes. It remains Draft: the inherited
prefix policy below still prevents acceptance of the combined change.

## Prepared fixes

| Case | Contributor head | Required / prepared result |
| --- | ---: | ---: |
| Assistant usage chunk 5, summary c1=100, assistant final 7 for the same turn/step, summary c2=20, correction c1=110 | 242 | 137 |
| Restart after that fold, then correct c1 to 120 through an incremental persisted read | prior dedup state absent | 147 |
| Cached samples 10+20; changed revision returns a noncontiguous tail at seq 3, then an empty full read | 0 | 30; retry the same revision to recover 34 |

Compaction summaries now use a persisted replacement ledger keyed by their
compaction ID, independent of the assistant chunk/message replacement cursor.
Correcting an older summary subtracts its original token/cost attribution before
adding the new one. Schema 9 forces pre-ledger caches to refold readable sources;
unreadable sources keep their cached aggregates. The full-read result determines
whether a refold is safe, even when its preceding tail read was nonempty.

`testInterleavedCompactionAccounting` and `testEmptyFullRefoldKeepsLedger` in
`scripts/test-server.mjs` cover these cases. Both independent failures were
reproduced before applying the fixes; the server suite passes afterwards.

## Remaining merge blockers: inherited coverage

The current upstream contract was checked at DSH
[`22ddee3792402c3e70ec5f86a63c3e3e895a2f60`](https://github.com/deepseek-ai/deepseek-harness/commit/22ddee3792402c3e70ec5f86a63c3e3e895a2f60):

- [`Session`](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/session/src/index.ts)
  exposes `header` and `inheritedEventCount`; it does not expose the header's
  `isSeeded` as a direct Session property. Ordinary `SessionStore.fork()` omits
  `parentSession`. That field is not a complete fork ancestry index.
- [`SessionHeader`](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/session/src/types.ts)
  describes lineage; the exact inherited cut is separate Session state.
- [Persistence handles](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/docs/subsystems/persistence.md)
  pair `header` and `inheritedEventCount` with body reads. Listing metadata plus a
  wall-clock cutoff cannot substitute for that cut.

Two synthetic reproductions still fail on this preparation branch:

1. **Current ordinary live fork:** parent has usage 5. Child has an inherited
   copy of 5 followed by its own 7; its metadata is
   `{ header: { isSeeded: true, createdAt }, inheritedEventCount: 1 }`, without
   `parentSession`. Collecting both yields **17 instead of 12**. Reading direct
   `session.isSeeded` misses the live header, and borrowing listing metadata
   cannot resolve the ordinary fork through a missing parent ID.
2. **Partial parent surviving on the same day:** cache a parent's surviving
   11:00 sample of 5. Add a child created at 12:00 with copied 09:00 usage 10,
   copied 11:00 usage 5, and its own 12:00:01 usage 7; the child's metadata names
   the parent. Collection yields **12 instead of 22**. The parent's earliest
   calendar day proves neither coverage of the 09:00 sample nor coverage of the
   entire copied range, so `seededCutoffFor()` deletes the only surviving 10.

These fixtures use generated events, not private logs or real account evidence.
The contributor's reported console comparison is useful real feedback, but it
does not establish correctness for these ancestry/coverage cases.

## Next implementation and acceptance

1. Read the exact inherited offset from the live Session and the same persisted
   handle used for the body. Keep an explicitly documented compatibility path
   for older host builds; do not infer exact ownership from timestamps alone.
2. Define and implement unique historical sample ownership when a parent is
   absent or partially compacted, including ordinary forks without parent IDs.
   Retain a copied sample only once when it is the surviving historical copy.
   Store only secret-free usage identity/provenance, never complete event bodies.
3. Add both fixtures above to the passing regression suite, plus child-before-
   parent listing order, multiple/nested orphan copies, equal timestamps, restart,
   inherited-cut changes, and removal of previously known parent coverage.
4. Verify cache migration cannot resurrect duplicated totals or erase the only
   historical copy; then run exact-head CI and compare a sanitized real-host day
   against the host console with installed commit and host version recorded.

Until these conditions pass, neither the contributor PR nor this combined Draft
is ready to merge. This branch does not change release or catalog metadata.

## Other tracked gates checked on 2026-10-27

- #129 has no user acceptance details newer than the 2026-10-16 request. The
  installed head, absence of explicit bypasses, sanitized account status and
  actual CN quota host/path remain unproven. Its closed state is not evidence.
- #133 remains Draft at `ffa611df30ca9ab43f82480a5a9bdef7f252dd53` with CI success.
  The upstream search for `web/deepseek-search-usage` still returns no producer;
  simulated replay does not establish a real emitted/persisted event.
- Providers Hub's published `2.7.261027` tarball passed its registry SHA-512
  integrity check. A scan of 487 JS/TS/JSON/Markdown files found no
  `creditBalance`, `creditsBalances`, or `supportedProviders`. Upstream service
  proposal [#9](https://github.com/iJetLi/dsh-providers-hub/pull/9) remains closed
  without merge. No real two-plugin service acceptance or stable enablement is
  justified by the new package version.
- Usage Stats npm latest remains `0.3.6`. Its frozen published source remains
  distinct from newer main. No npm publication, tag, stable catalog switch,
  merge, issue closure, follow-up comment is part of this preparation.

## Local validation

- `TZ=UTC npm run check`: passed.
- `TZ=UTC npm run test:server`: passed, including migration, restart and retry.
- Full `TZ=UTC npm test`: bundle, client, overlay, server, export, identity,
  OrcaRouter, pricing, billing, balance and subscriptions suites passed; the
  accounts suite stopped at the previously observed synchronous pinned-network
  subprocess `spawnSync ETIMEDOUT`. It is not recorded as a full local pass.
- The remaining CodeArts (57 cases) and installer suites passed when run
  separately. No real API credentials or private account logs were used.
- Contributor exact-head CI [40280013125](https://github.com/Ychris12138/dsh-usage-stats/actions/runs/40280013125)
  passed check and all npm test suites. The added regression failures were not
  present in that CI; the preparation commit needs its own exact-head run.
