# v0.3.6 release plan

Status: scope frozen; npm publication is the remaining user-owned step. The final release commit, tarball hashes, and final-head CI results belong in the external release manifest and draft-release assets, avoiding a self-referential commit hash inside the package. Package/catalog metadata alone does not establish npm publication.

## Included scope

| Change | Source | Acceptance and limits |
| --- | --- | --- |
| Command Code plans, quota windows, and credits | #126, already on main (`da11021f432ab7de836704e09acd9e6024fd34e7`) | Experimental: upstream `/alpha/*` endpoints are private and unversioned. No new independent real-account acceptance. |
| Z.ai / 智谱 CN credential compatibility | #130 (`bcddd0de8ca7248c051642ef2fafffc99a653cad`) | Automated canonical CN/global credential, explicit override, and routing coverage. Reporter confirmed a working card on 2026-10-15; no independent maintainer-owned account test. |
| MiniMax CN credentials and regional selection | #135 (`77e17213e6acbd486894443a98f6bea3af1caa49`) | Real Desktop 0.3.6 upgrade on 2026-10-17: `minimax-cn` was live with 5-hour and weekly windows; manual refresh worked. This validates subscription quota lookup, not API wallet balance or post-call quota movement. |
| DeepSeek Desktop account-service recovery | #136 (`72681ed969dc7bfc23ab7e45c5dc2677e6a88489`) | The same real Desktop 0.3.6 upgrade returned a live Host-owned account balance. Late service activation, replacement/removal, sign-out, and Cordis proxy identity have automated regression coverage. |

## Completed acceptance

Accepted integration `6df461289ed355c02bec53590dd0931950813b4a` passed a clean dependency install, static/release checks, all 13 offline suites, and GitHub CI on 2026-10-17. Its 0.3.6 tarball matched every packed source file and installed successfully into an isolated DSH web profile using Node 24.19.0 and DSH 0.2.0-rc.2.

The isolated smoke covered provider/usage/account/export endpoints, panel open/close, switching, refresh, selection after client reload, light/dark themes, and a narrow panel. A subsequent real Desktop upgrade retained Token totals, provider selection, and profile patch/credential-file metadata; installed runtime matched the accepted source. Both MiniMax CN quota and DeepSeek Account balance displayed live results.

Final preparation changes release documentation only. Preserve executable/runtime equivalence to that accepted build; regenerate and inspect the final frozen tarball, compare every packed file with the final commit, and record final-head CI before handoff. Real-account sign-out/service removal, global MiniMax, official-dashboard reconciliation, and post-call quota movement are not newly accepted live checks.

## Deferred scope

- Web-search #133: real DSH event emission/contract remains unverified; its cache-schema change is excluded.
- CodeArts / Providers Hub #128: the required `creditBalance` Host service is not published; branch conflicts and real two-plugin acceptance remain outstanding. It is independent of native MiniMax support.
- Volcengine #74: an official CLI contract is identified, but an independent adapter, authentication design, and a sanitized real response fixture are still needed.

Cache schema remains 5, with no migration or archive rescan. Preserve user monitors and credentials. Diagnostics contain only versions, route/reference names, sanitized status, and request host/path as needed; never keys, cookies, authorization headers, or full HARs.

## Frozen publication handoff

1. Record the final clean source commit as `RELEASE_SHA` in an external manifest, alongside the frozen `.tgz` SHA-256 and npm SHA-512 integrity. Publish that exact artifact, not a fresh pack from a different checkout.
2. Prepare a GitHub draft release for `v0.3.6`, targeting the full `RELEASE_SHA`, and attach the tarball and verification manifest. Keep it unpublished and verify that no tag was created prematurely.
3. The user publishes the frozen tarball to npm. Then verify registry version, `dist.integrity`, and downloaded tarball bytes against the manifest and source before changing `main`, tags, or the public release.
4. Fast-forward `main` to the exact `RELEASE_SHA`; do not squash, rebase, or recreate the published changes. This triggers Pages automatically, so npm verification must come first. Verify the deployed catalog identifies npm 0.3.6.
5. Create an annotated/signed `v0.3.6` tag explicitly at `RELEASE_SHA`, verify its target, and publish the prepared draft. Complete Desktop Market installation verification and issue closeout afterward.

If `main` can no longer fast-forward, stop and reassess provenance before publication; do not force-update it. Follow [the release checklist](release-checklist.md) for the remaining evidence.
