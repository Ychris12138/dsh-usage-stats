# Compact token counts (preparation for #160)

Token counts in the sidebar, today/month/all-time summary, recent days,
provider/model rankings, day detail and session metadata use readable labels.
The account balance, percentages, costs, sorting, API responses, cache and
CSV/JSON downloads retain their existing semantics and values.

Counts below 10,000 retain full grouped numbers. Larger counts use up to two
decimal places, trimming trailing zeros:

| Source count | Chinese UI | English UI |
| ---: | --- | --- |
| 12,345 | 1.23万 | 12.35K |
| 1,000,000 | 1百万 | 1M |
| 10,000,000 | 1千万 | 10M |
| 123,456,789 | 1.23亿 | 123.46M |
| 1,000,000,000,000 | 1万亿 | 1T |

These are rounded display labels. A value that rounds over a unit boundary is
promoted, e.g. 999,999 becomes 1M, rather than 1000K. The UI's translated locale
chooses the units; the browser's system language does not override that choice.
Missing, nonnumeric, negative or nonfinite values display an em dash.

Standalone count labels carry the unshortened value in both the tooltip and
accessible name. Shortened standalone counts can receive keyboard focus. Counts
inside the sidebar button do not introduce a nested tab stop. Compound day/model
summaries and session metadata expose complete counts in their native title.
Calendar-cell tooltips already contain full values and remain unchanged.

## Verification and remaining review

Client regressions cover Chinese/English units, zero, small counts, thresholds,
rounding promotion, invalid values, the maximum safe integer's full value,
tooltip/accessible labels, badge tab behavior and locale changes. Existing
rankings, exports, account selection and daily-detail behavior remain covered.

Before accepting this Draft, check the tooltip and long-count layout in an
installed DSH on wide and narrow panels, including Chinese/English switching.
This is display preparation, not real-account reconciliation. The separate
pending nested-fork fix #159 remains a higher-priority accounting change.
No version, published artifact, tag or stable catalog entry is changed here.
