# v0.3.6 release notes

This release restores account lookup for native DSH Z.ai / 智谱 and MiniMax routes, recovers DeepSeek Desktop balances after account-service loading, and includes the experimental Command Code adapter already merged into main.

## Changes

- Z.ai / 智谱: canonical `zai-coding-cn` routes use `ZAI_CODING_CN_API_KEY`, with the existing CN-only legacy `ZAI_API_KEY` fallback. Global `zai` routes continue using `ZAI_API_KEY`. Explicit monitor/provider credential references remain authoritative, including when the referenced credential is missing.
- MiniMax: id-only `minimax` and `minimax-cn` routes resolve `MINIMAX_API_KEY` and `MINIMAX_CN_API_KEY` respectively. The two defaults never fall back to each other. Region selection honors monitor configuration, then `MINIMAX_API_REGION`, then route inference; known regions and explicit quota endpoints remain pinned. Custom routes do not silently inherit native credentials.
- DeepSeek Account: resolve the Host service when it is used, so late loading or reloading no longer leaves the card permanently unsupported. Service replacement/removal or login changes invalidate the previous balance; repeated Cordis proxy reads preserve normal caching. Restart Desktop after installing a new server-side plugin build.
- Command Code: show plan, 5-hour/weekly/monthly quota windows, and credits. This adapter uses private, unversioned `/alpha/*` endpoints and remains experimental; upstream changes can make its account card unavailable.

## Validation and compatibility

On 2026-10-17, Node 24.19.0 and DSH Desktop 0.2.0-rc.2 were used to validate the integrated 0.3.6 package:

- Clean dependency installation, static/release checks, and all 13 offline test suites passed. GitHub CI also passed for the accepted integration commit.
- An isolated web profile installed the packaged tarball. Provider, usage, account, and export endpoints returned HTTP 200; panel open/close, provider switching, manual refresh, retained selection after reload, light/dark themes, and a narrow panel were checked.
- The existing Desktop profile upgraded to the packaged 0.3.6 build. Both a real MiniMax CN subscription and a real signed-in DeepSeek Account returned live results. MiniMax showed 5-hour and weekly windows, and manual refresh succeeded.
- The Desktop upgrade retained Token totals, provider selection, and profile patch/credential-file metadata. Installed runtime files matched the accepted source. The final documentation-only release preparation retains that runtime; its exact source commit and archive hashes are recorded outside the package in the frozen release manifest.

The Z.ai issue reporter confirmed a working card on 2026-10-15. No independent maintainer-owned Z.ai, global MiniMax, or new Command Code real-account acceptance is claimed. MiniMax official-dashboard reconciliation and post-call quota movement were not checked. Account sign-out and service-removal behavior are covered by automated tests; the live account was not signed out for this release test.

See [the release plan](release-plan-v0.3.6.md) for scope and [the release checklist](release-checklist.md) for the final artifact and publication handoff.

DSH 0.1.x API-key compatibility remains covered by capability detection. Cache schema stays at 5; no cache deletion, migration, or one-time archive rescan is needed. Existing credentials and account monitors are retained. Costs remain estimates; unknown pricing and incomplete or mixed-currency amounts remain unknown rather than being guessed.

## Scope and safety

Web-search accounting (#133), CodeArts / Providers Hub account pools (#128), and Volcengine account lookup (#74) are not included. MiniMax subscription quota does not imply API wallet-balance support. Missing services, credentials, or unrecognized responses keep explicit unavailable/error states.

Credentials stay Host/server-side and are not included in browser account payloads or exports. The plugin remains sidebar-only, without composer integration; loopback request and export protections remain in place.
