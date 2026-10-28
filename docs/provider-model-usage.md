# Provider and model usage ranking

Preparation for [Issue #155](https://github.com/Ychris12138/dsh-usage-stats/issues/155).

The usage panel adds a **Usage by provider and model** section below the calendar.
The default range is the calendar's selected month; **All records** includes every
day returned by the existing usage API. Changing the calendar month updates the
monthly ranking. Each provider expands to show its models.

Providers are ordered by their summed token usage; models within each provider
are ordered by their token usage. Ties use the exact attribution key for stable
ordering. The value is the existing token total, including cache tokens under the
existing server accounting semantics, rather than requests, currency, or a quota
percentage. Duplicate model rows across days are summed once per input row.

Grouping uses the exact route before the first slash in the existing
`provider/model` attribution key. `zai-coding-cn` and `zai-coding-cn-2` stay separate;
models containing additional slashes retain their full identity. Legacy keys
without a route are placed under Unknown provider, without guessing an account.
Invalid token values are excluded. Empty periods explicitly show no model data.

The range selector does not switch the balance account, change the persisted
manual provider choice, or create new network requests. It only renders the
existing API's daily model rows. It cannot recover usage absent from those rows
or correct upstream seeded-session double counting. PR #153/#154's accounting
acceptance remains separate; this feature is based on main, not either branch.

## Review and verification

Client smoke checks cover cross-day sums, selected-month/all-record filtering,
provider/model ordering and ties, separate routes serving the same model, slash
model IDs, legacy keys, invalid values, empty periods, immutable input, range
changes, calendar-month changes, and preservation of account selection/network
behavior. Existing daily detail and account-picker checks remain active.

Before acceptance, inspect the expanded section on a narrow and wide layout in
the real host, switch the calendar month and range, and compare group totals to
the corresponding daily model rows. This is display preparation; synthetic
tests do not establish real-account correctness. No package version, tag, npm
publication, or stable catalog entry is changed.
