# v0.3.7 release plan

## Scope

Includes post-0.3.6 mainline #141/#142/#144/#145/#146/#147/#149/#150/#151 and
#153/#154/#156. Contributor histories are preserved through the maintainer
follow-ups. #133 and #143 remain Draft; #152 awaits its contributor implementation.

## Validation

- Static/release metadata checks and all 14 automated suites on the integrated tree.
- Exact-head GitHub checks for merged changes and the release source.
- Actual React ranking component checked with synthetic data at 440px and 300px:
  group expansion, full model identity, range changes and no horizontal overflow.
- Cache schema 10 tests cover inherited ownership, original removal, restart,
  migration, unavailable source retry and compaction corrections.
- No new real-account billing reconciliation is claimed. Retain explicit old-Host,
  unreadable-cache and optional-provider limitations in the release notes.

## Freeze and publication

Prepare on release/v0.3.7. Package/lockfile/README/catalog versions must agree.
Do not merge the changed catalog into main until exact npm bytes are verified:
Pages deploys automatically from main. Record the full source SHA and artifact
hashes in an external manifest, not in the source commit itself.

Freeze one tarball, compare each packaged file against that commit and reject
credentials, output, caches, backups and test fixtures. Retain SHA-256, SHA-1 and
npm SHA-512 integrity. Prepare an unpublished GitHub draft targeting the source;
verify no v0.3.7 tag exists before npm publication.

The user publishes the frozen tarball. Afterwards verify registry identity,
latest tag, integrity and downloaded bytes; fast-forward main to the exact frozen
source only if still safe, verify Pages/catalog, then create v0.3.7 at that source
and publish the GitHub draft. A concurrent main change requires review, never a
force update. Installed Desktop/real-account acceptance must be reported separately.
