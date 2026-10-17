# v0.3.6 release checklist

This checklist prepares `@ychris12138/dsh-usage-stats` v0.3.6. It does not authorize npm publishing, tagging, or creating a GitHub Release. Historical acceptance belongs in the corresponding release notes; unchecked items below are not completed by prior-version checks.

## 1. Scope and provenance

- [ ] Record the reviewed integrated commit as `RC_SHA`; include #126, #130, #135, and #136, with the source heads in [the release plan](release-plan-v0.3.6.md).
- [ ] Keep #133, #128, and #74 out of the advertised support and code scope.
- [ ] Review v0.3.6 notes, package file allow-list, and README status. Describe Command Code as experimental, MiniMax as subscription quota, and all costs as estimates.
- [ ] Synchronize package, lockfile, candidate catalog, and README metadata with `npm run release:sync -- 0.3.6`. Candidate metadata does not change which version is published on npm.
- [ ] Keep the candidate catalog off `main` until npm 0.3.6 exists: the Pages workflow automatically deploys catalog changes from `main`.

## 2. Exact-candidate automated gates

Run from a clean checkout of the candidate:

```bash
npm ci
npm run check
npm test
npm pack --json
```

- [ ] All checks and 13 offline test suites pass for this integrated commit; GitHub CI reports success for the same commit.
- [ ] The pack contains v0.3.6 notes, the quoted Cordis identity, and the matching client loader identity. It contains no credentials, local test output, caches, screenshots, backups, or review artifacts.
- [ ] Preserve coverage for malformed settings, loopback/GET API and export restrictions, explicit credential overrides, region pinning, DeepSeek service lifecycle, and cache persistence/incremental folding.

## 3. Packaged DSH acceptance

- [ ] Install the exact tarball into an isolated DSH profile, restart that Host, and hard-refresh the client. Record the tarball hash, source commit, Node/DSH versions, and resolved profile.
- [ ] Verify no plugin/loader failures, the sidebar panel opens and closes, provider switching and manual refresh work, and the plugin registers no composer UI. Check light/dark rendering and a narrow panel.
- [ ] Upgrade an existing 0.3.5 profile while retaining its monitor settings and schema-5 usage cache. Confirm totals and provider selection survive restart; no credentials or providers are inserted automatically.
- [ ] On the final packaged candidate, recheck the available MiniMax CN subscription and DeepSeek Account. Preserve separate CNY/USD wallets and confirm previously cached balances are not retained after account/service removal.

Already observed on 2026-10-17 using local 0.3.5-labelled fix packages:

- [x] DSH Desktop 0.2.0-rc.2: a real `minimax-cn` account shows live 5-hour and weekly windows; manual refresh succeeds.
- [x] DSH Desktop 0.2.0-rc.2: a real signed-in DeepSeek Account balance recovers after installing the service-lifecycle fix and restarting Desktop.

These observations do not mark the final-tarball checks above complete. Z.ai has reporter confirmation and automated coverage; no independent maintainer-owned account test is claimed. Global MiniMax, post-call quota movement, and new independent Command Code real-account checks remain untested. They must not be described as verified release behavior.

## 4. Immutable release handoff

- [ ] Finish the candidate checks and review the final notes before creating the release metadata commit.
- [ ] Once publishing is authorized, replace candidate-only wording and update npm installation examples to 0.3.6 before creating the immutable release commit. Repack that final documentation with the accepted code.
- [ ] Commit all accepted source/version/release metadata; record the exact clean commit as `RELEASE_SHA`. Confirm the committed package version is 0.3.6, not just the working-tree version.
- [ ] Repeat check/test/pack if the release commit changes executable code or the package manifest after candidate acceptance; inspect the final pack in all cases.

The release identity must remain:

```text
npm published source commit
== v0.3.6 tag commit
== GitHub Release commit
== package/catalog version commit
== RELEASE_SHA
```

## 5. Publish and Market closeout

Only execute after the immutable release commit exists and the maintainer explicitly authorizes publishing.

- [ ] Confirm the npm publisher, then publish from a clean checkout at exactly `RELEASE_SHA` using the public npm registry.
- [ ] Confirm npm exposes exactly 0.3.6. Only then merge/push the catalog/release commit to `main`, without recreating the version changes.
- [ ] Create the annotated/signed `v0.3.6` tag explicitly at `RELEASE_SHA`; verify the tag resolves to that commit and create its GitHub Release.
- [ ] Verify public Pages catalog identity/content type/version, then install exact npm 0.3.6 through DSH Desktop Community Market and restart the Host.
- [ ] Close release/issues only after their accepted fixes are merged and the relevant checks pass.
