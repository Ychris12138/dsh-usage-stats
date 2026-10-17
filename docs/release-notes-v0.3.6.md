# v0.3.6 release notes

Status: unpublished release candidate. The published npm version remains 0.3.5.

This release restores account lookup for native DSH Z.ai / 智谱 and MiniMax routes, recovers DeepSeek Desktop balances after account-service loading, and includes the experimental Command Code adapter already merged into main.

## Changes

- Z.ai / 智谱: canonical `zai-coding-cn` routes use `ZAI_CODING_CN_API_KEY`, with the existing CN-only legacy `ZAI_API_KEY` fallback. Global `zai` routes continue using `ZAI_API_KEY`. Explicit monitor/provider credential references remain authoritative, including when the referenced credential is missing.
- MiniMax: id-only `minimax` and `minimax-cn` routes resolve `MINIMAX_API_KEY` and `MINIMAX_CN_API_KEY` respectively. The two defaults never fall back to each other. Region selection honors monitor configuration, then `MINIMAX_API_REGION`, then route inference; known regions and explicit quota endpoints remain pinned. Custom routes do not silently inherit native credentials.
- DeepSeek Account: resolve the Host service when it is used, so late loading or reloading no longer leaves the card permanently unsupported. Service replacement/removal or login changes invalidate the previous balance; repeated Cordis proxy reads preserve normal caching. Restart Desktop after installing a new server-side plugin build.
- Command Code: show plan, 5-hour/weekly/monthly quota windows, and credits. This adapter uses private, unversioned `/alpha/*` endpoints and remains experimental; upstream changes can make its account card unavailable.

## Validation and compatibility

A real MiniMax CN subscription returned live 5-hour and weekly quota windows in DSH Desktop 0.2.0-rc.2 on 2026-10-17, and manual refresh succeeded. A real signed-in DeepSeek Desktop account recovered its balance after installing the fix and restarting the Host on the same day. Those observations used local test packages still labelled 0.3.5. The Z.ai issue reporter confirmed a working card on 2026-10-15; no independent maintainer-owned Z.ai account test is claimed.

The final 0.3.6 tarball still requires its own automated gates and isolated installation smoke. Global MiniMax real-account acceptance, post-call quota movement, and new independent Command Code real-account acceptance are not claimed. See [the release plan](release-plan-v0.3.6.md) for source heads and [the release checklist](release-checklist.md) for the final handoff.

DSH 0.1.x API-key compatibility remains covered by capability detection. Cache schema stays at 5; no cache deletion, migration, or one-time archive rescan is needed. Existing credentials and account monitors are retained. Costs remain estimates; unknown pricing and incomplete or mixed-currency amounts remain unknown rather than being guessed.

## Scope and safety

Web-search accounting (#133), CodeArts / Providers Hub account pools (#128), and Volcengine account lookup (#74) are not included. MiniMax subscription quota does not imply API wallet-balance support. Missing services, credentials, or unrecognized responses keep explicit unavailable/error states.

Credentials stay Host/server-side and are not included in browser account payloads or exports. The plugin remains sidebar-only, without composer integration; loopback request and export protections remain in place.
