# v0.3.4 release notes

`v0.3.4` is a focused compatibility hotfix for the DSH `0.1.7` web client primitives rename.

## Highlights

### DSH 0.1.7 primitives icon rename compatibility

- DSH `0.1.7` renamed the `@deepseek-ai/dsh-client-ui-primitives` icon set from size-suffixed names (`IconDataOutline16`, `IconRefreshOutline14`, `IconCloseOutline16`, `IconChevronLeftOutline14`, `IconChevronRightOutline14`) to stroke-weight variants (`IconDataOutlineRegular`, `IconRefreshOutlineRegular`, `IconCloseOutlineRegular`, `IconChevronLeftOutlineRegular`, `IconChevronRightOutlineRegular`; both variants accept the same `size` prop).
- The sidebar footer badge and the floating panel rendered those removed exports as an undefined component type, so React threw during the first render and the slot system abdicated the whole plugin entry: the usage panel disappeared from the sidebar after the DSH upgrade while the rest of the GUI kept working.
- All five icons are now resolved through a current-name-with-legacy-fallback alias table, so one client bundle keeps working on both pre-rename DSH builds and `0.1.7`+.

## Compatibility and non-features

- No host-half changes: every `/api/usage-stats/*` endpoint already worked after the upgrade.
- No slot registration, locale dictionary, or `dsh.client` manifest changes.
- No pricing-rule, billing-semantics, account-refresh, or cache-schema changes.
- Icon artwork follows the new Regular stroke weight at the previous sizes (14/16/18); no layout or theme changes.
