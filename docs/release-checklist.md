# Release checklist

This is the release gate for `@ychris12138/dsh-usage-stats`. Completing the checklist prepares a release; it does not authorize npm publishing, tagging, or creating a GitHub Release.

## 1. Release candidate identity

- [ ] Start from a reviewed, clean `main`; record the exact commit SHA.
- [ ] Run `npm run release:sync -- <version>` once to update `package.json`, `package-lock.json`, and the Community Market catalog together.
- [ ] Remove release-candidate wording/status from the target version's release notes after the final version sync.
- [ ] Confirm `npm run check:release` reports the scoped package identity and target version.
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
- [ ] Confirm `display.currentSessionPill` defaults on and `false` removes the Pill without affecting the sidebar panel.
- [ ] Confirm a persisted provider selection survives browser refresh and DSH restart; removing that provider clears the saved id and uses the existing fallback.

## 4. Export and security

- [ ] Download daily CSV, session CSV, and the versioned JSON export.
- [ ] Check commas, quotes, CR/LF, Unicode titles, and spreadsheet-formula prefixes.
- [ ] Confirm incomplete/mixed-currency estimates export as blank/null rather than partial amounts.
- [ ] Search every export for credential names/values, Authorization, cookies, raw URLs with userinfo/query data, prompt text, response text, and file paths.
- [ ] Confirm exported pricing provenance contains only public rule/source metadata.

## 5. Real DSH release-candidate regression

- [ ] Test the latest supported `@deepseek-ai/dsh` Desktop/Web release candidate with an isolated profile.
- [ ] Confirm DSH starts without `Failed to load plugins` or loader identity errors.
- [ ] Confirm client bundle load, sidebar entry, panel open/close, provider switching, Current Session Pill, cost/budget states, and manual Retry.
- [ ] Test light and dark themes; confirm a missing composer mount point degrades silently.
- [ ] With `refresh.enabled: false`, confirm one first account fetch, no expiry-driven upstream requests, manual Retry, and a fresh fetch after provider configuration changes.
- [ ] Recheck #53 only in an available enterprise proxy environment; record evidence, but do not infer a fix without reproduction.
- [ ] Recheck #14 with a real MiniMax Coding Plan account: both current and weekly windows plus reset information. Record the sanitized response shape if it fails.

## 6. Publish and market closeout

Do not run this section until the release candidate PR is approved and the maintainer explicitly authorizes publishing.

- [ ] `npm whoami` returns the expected publisher.
- [ ] `npm publish --access public --registry=https://registry.npmjs.org/` succeeds.
- [ ] `npm view "@ychris12138/dsh-usage-stats" version --registry=https://registry.npmjs.org/` equals the target version.
- [ ] Only after npm verification: create the signed/annotated tag and GitHub Release from the recorded `main` SHA.
- [ ] Verify the public Pages `catalog-source.json` and `/v1/plugins` response content type, package name, and exact version.
- [ ] Install the exact npm version through DSH Desktop Community Market and restart the host.
- [ ] Close the npm/market release issue only after the Desktop Market installation succeeds.
