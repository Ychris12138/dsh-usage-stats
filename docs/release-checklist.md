# Release checklist

This is the release gate for `@ychris12138/dsh-usage-stats`. Completing the checklist prepares a release; it does not authorize npm publishing, tagging, or creating a GitHub Release.

## 1. Release candidate baseline

- [ ] Start from the reviewed release-candidate PR merged into a clean `main`; record this commit as `RC_BASE_SHA` for provenance only.
- [ ] Do not publish or tag `RC_BASE_SHA`: the release version has not been committed yet.
- [ ] Confirm `cordis.patch.yml` quotes `@ychris12138/dsh-usage-stats` and `lib/client.js` registers the same identity through `__ModuleLoader__.load()`.
- [ ] Confirm the release notes describe estimated costs as estimates and list every unsupported/fail-closed case.

## 2. Automated gates

```bash
npm ci
npm run check
npm test
npm pack --json
```

- [ ] Inspect the pack manifest: no credentials, local caches, screenshots, backups, review diffs, or untracked planning files.
- [ ] Install the generated tarball into an isolated DSH profile; do not validate only against the source checkout.
- [ ] Confirm malformed settings fail before routes or timers register.
- [ ] Confirm non-GET and non-loopback export/API requests remain rejected.

## 3. Fresh install and migration

- [ ] Fresh isolated profile: install, restart DSH, hard-refresh the browser, open Usage Stats.
- [ ] Upgrade an existing v0.2.10 profile without deleting its usage cache or monitor configuration.
- [ ] Confirm a valid old cache is migrated/refolded and retains exact token totals.
- [ ] Replace the cache with malformed JSON; confirm the plugin rebuilds from authoritative session events without blocking DSH startup.
- [ ] Confirm existing account monitors remain compatible and no new provider/monitor is inserted into user configuration.
- [ ] Confirm legacy `display.currentSessionPill: true` and `false` configurations both start successfully and neither registers composer UI.
- [ ] Confirm a persisted provider selection survives browser refresh and DSH restart; removing that provider clears the saved id and uses the existing fallback.
- [ ] Confirm OrcaRouter is added only through the explicit fresh-user synthetic Add action; startup performs no settings mutation and existing provider configuration is not overwritten.
- [ ] Confirm OrcaRouter balance succeeds through `/v1/balance` or the compatible billing fallback, pricing stays unknown/null, and no credential value reaches the browser or export payloads.
- [ ] Confirm unchanged persisted fallback logs read only from the folded cursor, appended events remain incremental, and truncation/rewrite still refolds from sequence 0 (#58/#57).

## 4. Export and security

- [ ] Download daily CSV, session CSV, and the versioned JSON export.
- [ ] Check commas, quotes, CR/LF, Unicode titles, and spreadsheet-formula prefixes.
- [ ] Confirm incomplete/mixed-currency estimates export as blank/null rather than partial amounts.
- [ ] Search every export for credential names/values, Authorization, cookies, raw URLs with userinfo/query data, prompt text, response text, and file paths.
- [ ] Confirm exported pricing provenance contains only public rule/source metadata.

## 5. Real DSH release-candidate regression

### v0.3.2-specific gates

- [ ] Current DSH sessions use the public `seq` / `snapshotEvents()` API; no current-session path accesses the removed `session.events` property.
- [ ] Legacy sessions exposing `seq` plus an `events` array, but no `snapshotEvents()`, remain supported.
- [ ] UI steady state performs zero persisted `listSnapshots`, zero persisted `readFrom`, zero unchanged aggregate rebuilds, and zero unchanged cache writes.
- [ ] Background refresh skips `readFrom` and cache writes for unchanged revisions, uses incremental reads for changed revisions, and full-refolds truncation or rewrite cases.

- [ ] Test the latest supported `@deepseek-ai/dsh` Desktop/Web release candidate with an isolated profile.
- [ ] Confirm DSH starts without `Failed to load plugins` or loader identity errors.
- [ ] Confirm client bundle load and that `sidebar.footer.action` is the only extension point registered by dsh-usage-stats; verify panel open/close, provider switching, cost/budget states, and manual Retry.
- [ ] At 700 / 500 / 400 / 320 px, confirm dsh-usage-stats registers no `conversation.input.*` component or composer DOM and leaves native Permission / Model / Context / Submit layout untouched. Record any remaining sub-400 px overlap as DSH host behavior rather than changing host controls from this plugin.
- [ ] Test the sidebar action and panel in light and dark themes.
- [ ] Confirm Last 14 days token values retain an 84 px minimum width, right alignment, and tabular numerals while the date column shrinks/ellipsizes without adding narrow-panel overflow (#75).
- [ ] With `refresh.enabled: false`, confirm one first account fetch, no expiry-driven upstream requests, manual Retry, and a fresh fetch after provider configuration changes.
- [ ] Recheck #53 only in an available enterprise proxy environment; record evidence, but do not infer a fix without reproduction.
- [ ] Recheck #14 with a real MiniMax Coding Plan account: both current and weekly windows plus reset information. Record the sanitized response shape if it fails.

## 6. Create the immutable release commit

Do not run this section until every release-candidate gate above passes and the maintainer approves preparing the release commit.

- [ ] Create a release branch from the reviewed `main` at `RC_BASE_SHA`.
- [ ] Run `npm run release:sync -- 0.3.2` once to update `package.json`, `package-lock.json`, the Community Market catalog, and documented stable-version references together.
- [ ] Confirm the v0.3.2 release notes use final stable wording, preserve the historical v0.3.0/v0.3.1 notes, and do not claim #84 fixed or include #88 behavior.
- [ ] Run the release gates again against the synchronized version:

```bash
npm run check
npm test
npm pack --json
```

- [ ] Inspect the final pack manifest, then commit all version/release metadata changes with `chore: prepare v0.3.2 release`.
- [ ] Record that commit as `RELEASE_SHA`; this replaces `RC_BASE_SHA` as the only publish/tag identity.
- [ ] Confirm the working tree is clean and `HEAD` equals `RELEASE_SHA`.
- [ ] Confirm the committed package version, not merely the working-tree version:

```bash
test "$(git show "$RELEASE_SHA:package.json" | jq -r .version)" = "0.3.2"
```

The release invariant is:

```text
npm published source commit
== v0.3.2 tag commit
== GitHub Release commit
== package/catalog version commit
== RELEASE_SHA
```

## 7. Publish and market closeout

Do not run this section until the immutable release commit exists and the maintainer explicitly authorizes publishing.

- [ ] `npm whoami` returns the expected publisher.
- [ ] From a clean checkout/worktree at exactly `RELEASE_SHA`, run `npm publish --access public --registry=https://registry.npmjs.org/`.
- [ ] `npm view "@ychris12138/dsh-usage-stats" version --registry=https://registry.npmjs.org/` equals the target version.
- [ ] Merge or push the release commit to `main` according to the chosen branch workflow; verify `main` contains the exact `RELEASE_SHA` without recreating the release changes.
- [ ] Only after npm and `main` verification: create the signed/annotated `v0.3.2` tag pointing explicitly to `RELEASE_SHA`.
- [ ] Verify the tag resolves to the published source commit:

```bash
test "$(git rev-parse v0.3.2^{commit})" = "$RELEASE_SHA"
```

- [ ] Create the GitHub Release from `v0.3.2`; verify it resolves to `RELEASE_SHA`.
- [ ] Verify the public Pages `catalog-source.json` and `/v1/plugins` response content type, package name, and exact version.
- [ ] Install the exact npm version through DSH Desktop Community Market and restart the host.
- [ ] Close the npm/market release issue only after the Desktop Market installation succeeds.
