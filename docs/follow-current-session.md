# Follow current session

Implements #152 as an opt-in sidebar feature. It defaults off, preserving upgrade
behavior. Enable it to follow the exact confirmed provider route of the single
main-view Session. Manual selection immediately disables follow; automatic routes
never overwrite the last manual preference. Disabling restores that preference.

The client optionally injects sessions/modelDirectories, subscribes to the ready
list snapshot's retainedBy.mainView and the directory's confirmed current model,
and requires ready/routable state without pending selection or errors. The base
panel still requires only slots/locale. Older or incomplete service shapes fall
back to manual mode; there is no guessed active Session, account-brand matching,
polling or forced upstream quota refresh. Session-context display settings do not
control this path. An internal account pool behind one route is outside scope.

Late directory loads, service replacement, reconnect/pending lists, main-view
changes and manual actions are generation-isolated. Subscriptions are released
when disabled, removed or unmounted. An unmatched route keeps the manual card and
shows its status, rather than switching to another account of the same brand.

Automated controller and mounted React regressions cover separate same-brand
accounts, exact matching, pending model changes, background/ambiguous/no sessions,
stale load completion, removal/replacement, service absence/late activation,
storage failures, persistent manual preferences, reload, cleanup and no forced
quota calls. These are synthetic identity/quota tests, not real account billing
reconciliation. Before announcing broader Host compatibility, verify that Host's
actual service shape and ready/retention semantics. Missing capabilities are an
intentional visible downgrade.
