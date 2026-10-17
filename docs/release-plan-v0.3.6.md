# v0.3.6 release plan

Status: release preparation. The published npm version is still 0.3.5. A version or catalog change on the release branch is candidate metadata, not evidence of publication. Publishing, tagging, and creating a GitHub Release are separate actions.

## Included scope

| Change | Source | Acceptance and limits |
| --- | --- | --- |
| Command Code plans, quota windows, and credits | #126, already on main (`da11021f432ab7de836704e09acd9e6024fd34e7`) | Retain the experimental label: the upstream `/alpha/*` endpoints are private and unversioned. No new independent real-account acceptance is claimed. |
| Z.ai / 智谱 CN credential compatibility | #130 (`bcddd0de8ca7248c051642ef2fafffc99a653cad`) | Automated tests cover canonical CN/global credentials, explicit overrides, and regional routing. The issue reporter confirmed that the card works on 2026-10-15; the maintainer has not independently tested a Z.ai account. |
| MiniMax CN credentials and regional selection | #135 (`77e17213e6acbd486894443a98f6bea3af1caa49`) | On 2026-10-17, DSH Desktop 0.2.0-rc.2 with the local combined 0.3.5 test package displayed a real `minimax-cn` account as live, including 5-hour and weekly windows; manual refresh succeeded. This validates subscription quota lookup, not API wallet balance or usage changes after a model call. |
| DeepSeek Desktop account-service recovery | #136 (`72681ed969dc7bfc23ab7e45c5dc2677e6a88489`) | On 2026-10-17, installing the local fix and restarting Desktop restored a real signed-in account balance. Automated tests cover late service activation, replacement/removal, login changes, and Cordis proxy identity. |

The earlier real Desktop checks exercised fixes also present in combined candidate `ce5943490a8a42aef27fdf1a71f7497d79a79469`, whose package version was still 0.3.5. PR #134 subsequently records isolated web installation and existing-Desktop upgrade of the exact 0.3.6 candidate `6df461289ed355c02bec53590dd0931950813b4a`, with retained totals/selection and working MiniMax CN/DeepSeek cards. Those records do not establish live sign-out/service-removal acceptance or resolve the Z.ai default-credential-path confirmation. Final publication remains a separate handoff.

Independent source/pack verification on 2026-10-17 confirmed that `6df4612` contains all three source heads, passes `TZ=UTC npm run check` and all 13 `TZ=UTC npm test` suites, and packs 28 files matching the checkout byte-for-byte. All relative document links resolve inside the package. Source-candidate tarball SHA-256: `11ba959fd067fd7ab415db5dfc4c95415586e2607dc2a8eed11a1a3e8a9d186e`. This hash belongs only to that source candidate; documentation changes require a new pack/hash.

## Deferred scope

- Web-search #133: the real DSH event contract and upstream emission are unverified. Keep its cache-schema change out of this release.
- CodeArts / Providers Hub #128: the required `creditBalance` Host service is not published; the original PR still needs conflict resolution and an actual two-plugin acceptance test. It is independent of the native MiniMax fix.
- Volcengine #74: an official CLI contract is now identified, but an independent adapter, authentication design, and a sanitized real response fixture are still needed. Do not advertise account support yet.

## Candidate gates

1. Record the exact integrated commit and ensure CI belongs to that commit. Run `npm ci`, `npm run check`, all test suites, and inspect `npm pack --json`.
2. Install that exact tarball into an isolated DSH profile. Verify startup, client loading, the usage panel, and manual refresh. Keep the Desktop and web profiles distinct; a browser refresh does not reload the Host plugin.
3. Preserve existing monitor configuration, credentials, and usage cache. This release retains cache schema 5 and requires no migration or archive rescan.
4. Record only package/DSH versions, route ids, credential-reference names, override presence, sanitized status/missingCredentials, and request host/path when useful. Never collect keys, cookies, authorization headers, or full HARs.
5. Distinguish mocked coverage, reporter confirmation, real-account observations, and remaining checks. Global MiniMax, maintainer-owned Z.ai, and post-call quota movement are not claimed as newly accepted real-account paths.

## Release handoff

Add v0.3.6 release notes to the package allow-list, synchronize package/lockfile/catalog metadata, and follow [the release checklist](release-checklist.md). Keep README installation instructions clear about the published npm version and the unpublished candidate.

The Pages workflow deploys catalog changes automatically from `main`. Keep the 0.3.6 catalog change on the release branch until the exact npm version exists; do not advertise an unavailable Market package. Do not close #129 until the accepted fix is merged. Avoid delaying accepted compatibility fixes for the deferred features above.
