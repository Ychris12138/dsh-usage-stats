# v0.3.6 release checklist

The maintainer delegated non-npm preparation and post-npm release closeout; npm publication remains the user's step. The checklist distinguishes accepted integration evidence from the final frozen artifact and public release.

## 1. Frozen scope and accepted integration

- [x] Include #126, #130, #135, and #136; retain the source heads in [the release plan](release-plan-v0.3.6.md).
- [x] Exclude #133, #128, and #74. Label Command Code experimental, MiniMax as subscription quota, and costs as estimates.
- [x] Synchronize package, lockfile, README identity, and catalog metadata to 0.3.6. Include current release notes and enforce their presence in the package file allow-list.
- [x] Accepted integration passed `npm ci`, `npm run check`, 13 offline suites, and exact-head GitHub CI on 2026-10-17. Missing/omitted release-note guards were verified.
- [x] Accepted tarball matched all packed source files and excluded local output, credentials, caches, screenshots, backups, and review artifacts.
- [x] Keep credential override, regional pinning, service lifecycle, incremental persistence, malformed-settings, and loopback/API/export safety regression coverage.

## 2. Packaged DSH acceptance completed on 2026-10-17

- [x] Install packaged 0.3.6 into an isolated web profile with Node 24.19.0 / DSH 0.2.0-rc.2. Provider, usage, account, and export endpoints return HTTP 200.
- [x] Verify the panel opens/closes, provider switching and manual refresh work, selection survives client reload, and light/dark themes and a narrow panel render. Retain sidebar-only integration.
- [x] Upgrade the existing Desktop profile to packaged 0.3.6, retaining Token totals, provider selection, and profile patch/credential-file metadata. Installed runtime matches the accepted source.
- [x] Real `minimax-cn` returns live 5-hour and weekly subscription windows; refresh succeeds. A real signed-in DeepSeek Account returns a live Host-owned balance.

Account sign-out/service removal and separate-wallet normalization are covered by automated tests; the live account was not changed to repeat those cases. Z.ai has reporter confirmation. Independent maintainer-owned Z.ai/global MiniMax/new Command Code tests, MiniMax official-dashboard reconciliation, and post-call quota movement remain untested and must not be described as live acceptance.

## 3. Final immutable artifact and user handoff

Record completion of these final gates in the external release manifest; the packaged checklist stays immutable after the source is frozen.

- [x] Finalize install references and release documentation before freezing the source; avoid candidate-only/stale install wording in the published package.
- [ ] Commit the final documentation preparation, ensure the checkout is clean, and record `RELEASE_SHA` in an external manifest/release asset. Do not embed a commit's own hash in its source files.
- [ ] Confirm executable/runtime files are identical to the accepted integration. Run final static/release checks and require successful GitHub CI on `RELEASE_SHA`; rerun substantive tests if executable code changes.
- [ ] Pack from exactly `RELEASE_SHA`, inspect its manifest, compare every packed file with that commit, and record the archive SHA-256 and npm SHA-512 integrity. Do not overwrite the frozen artifact later.
- [ ] Create/update an unpublished GitHub draft release targeting the full `RELEASE_SHA`, attach the frozen tarball and sanitized verification manifest, and confirm no `v0.3.6` tag was created.
- [ ] Hand the exact archive path and hashes to the user. The user verifies npm identity and publishes that tarball, without repacking the current directory:

```bash
npm whoami --registry=https://registry.npmjs.org/
npm publish "$RELEASE_ARCHIVE" --access public --registry=https://registry.npmjs.org/
```

`RELEASE_ARCHIVE` is the absolute path of the frozen, hash-verified tarball. Do not replace it with `.` or run another `npm pack` for publication.

## 4. Post-npm closeout

- [ ] Confirm npm exposes exact version 0.3.6. Compare registry `dist.integrity` and downloaded tarball bytes with the frozen manifest; verify package files match `RELEASE_SHA`. Registry `gitHead` alone is not sufficient proof.
- [ ] Only after npm verification, fast-forward `main` to exactly `RELEASE_SHA`. Do not squash/rebase the already-published source or force-update a diverged `main`.
- [ ] Verify the automatic Pages deployment and public catalog identity, content type, and exact 0.3.6 version. The workflow deploys catalog changes from `main`, so no earlier merge is permitted.
- [ ] Create an annotated/signed `v0.3.6` tag explicitly at `RELEASE_SHA`; verify it resolves to that commit, then publish the prepared GitHub draft release.
- [ ] Install exact npm 0.3.6 through DSH Desktop Community Market and restart its Host. Verify the installed package before closing the release and accepted issues.

The immutable release identity is:

```text
frozen tarball files == committed package files at RELEASE_SHA
registry tarball bytes == frozen tarball bytes
main at publication == v0.3.6 tag target == GitHub Release source == RELEASE_SHA
```
