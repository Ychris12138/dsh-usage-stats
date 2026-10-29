# v0.3.7 release checklist

## Preparation

- [x] Review scope and preserve #153/#147 contributor history.
- [x] Keep #133 out; label #143 experimental and #74 unaccepted; include #152 with manual fallback.
- [x] Validate integrated code with static checks and all 16 test suites.
- [x] Exercise real React ranking component at 440px/300px with synthetic data.
- [ ] Synchronize 0.3.7 metadata and require exact-source CI.
- [ ] Freeze a clean source commit and compare every packed file with it.
- [ ] Save tarball hashes, checks and acceptance limits in the external manifest.
- [ ] Prepare GitHub draft/assets without creating a public tag.

## npm and closeout

- [ ] User publishes the exact frozen tarball; never repack the current checkout.
- [ ] Verify official registry identity, latest, integrity and downloaded bytes.
- [ ] Fast-forward main to the frozen release source and verify Pages/catalog.
- [ ] Create v0.3.7 at that exact commit and publish the prepared GitHub draft.
- [ ] Verify exact npm installation in the intended DSH profile and report real
      acceptance separately from synthetic checks. Back up the usage cache first.

The package checklist remains frozen after packing; completed gates and hashes
belong in the external release manifest. See release-plan-v0.3.7.md and
release-notes-v0.3.7.md for scope, compatibility and publication order.
