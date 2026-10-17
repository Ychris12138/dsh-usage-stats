# v0.3.6 release plan

Status: preparation only. Stable package and catalog metadata remain at 0.3.5 until the acceptance gates below are complete.

## Scope

- Include the Command Code plans, quota windows, and credit balance support already on main in #126. Describe its private, unversioned upstream endpoints as experimental; do not imply official API stability.
- Include Z.ai CN route credential compatibility from #130 only after the reporter confirms the tested commit, absence of explicit credential overrides, and CN quota request target. A working-card screenshot alone does not establish those conditions.
- Consider standalone MiniMax id-only credential compatibility from #135 only after exact-head CI and real Coding Plan acceptance. The new MiniMax report in #129 has not supplied route, credential-reference, or region details; the reproduced registry-only failure is a candidate cause, not confirmed diagnosis. This fix does not depend on CodeArts #128.
- Keep web-search #133 out of the release scope until its event contract and intended upstream emission are validated. Its mocked response-event tests do not establish real DSH search accounting.
- Keep CodeArts #128 out until the required creditBalance service has a published upstream version, branch conflicts are resolved, and the actual two-plugin combination is accepted.
- Volcengine #74 remains a community contribution with missing CLI/API and real-account evidence.

## Merge and validation gates

1. Record accepted PR heads and an exact release candidate commit. Recheck that each CI result belongs to that head.
2. For #130, record only credential reference names, override presence, status/missingCredentials, and request host/path. Never request API keys, authorization headers, cookies, or full HARs.
3. If #133 is later included, retain regression coverage for A/B/A reports, incremental folding, assistant/search interleaving, cross-day token/cost replacement, invalid fields, cache restart, explicit included/additional reasoning-token semantics, and pre-v7-to-v7 rebuild. Describe the one-time archive rescan after the cache schema change.
4. Run npm ci, npm run check, all test suites, and inspect the npm pack manifest. Complete an isolated DSH install/API/UI smoke from the exact candidate tarball. Real account checks remain distinct from mocked tests.
5. For #135, record tested DSH/plugin versions and commit, route id, credential-reference names/override presence, region, sanitized status/missingCredentials, and quota request host/path. Clarify whether the requested data is Coding Plan quota or API wallet balance; do not claim the latter is supported by this adapter.
6. Confirm no pending external service or event contract is advertised as working in the stable release.

## Final release steps

After the accepted scope is frozen, use the existing release sync script to update package.json, package-lock.json, README stable references, and the Community Market catalog to 0.3.6 together. Add final v0.3.6 release notes and update the package file allow-list and release checklist as needed. Follow the established release checklist for exact npm version, main commit, tag, GitHub Release, and catalog verification.

Do not publish the catalog's new stable version before that exact npm version is available. Do not mark #129 completed until its accepted fix is merged. Avoid delaying an accepted compatibility patch solely to bundle unrelated provider features.
