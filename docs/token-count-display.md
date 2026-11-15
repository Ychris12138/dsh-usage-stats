> #159 is merged. Desktop validation covered default K/M, switching to Chinese units, preference persistence and a keyboard-accessible full value.

# Compact token counts (preparation for #160)

Token counts in the sidebar, today/month/all-time summary, recent days,
provider/model rankings, day detail and session metadata use readable labels.
The account balance, percentages, costs, sorting, API responses, cache and
CSV/JSON downloads retain their existing semantics and values.

International units are the default from 1,000. The panel offers a separately persisted Chinese-unit option, starting at 10,000. Both use up to two decimal places, trimming trailing zeros:

| Source count | Chinese units | Default K/M units |
| ---: | --- | --- |
| 12,345 | 1.23万 | 12.35K |
| 1,000,000 | 1百万 | 1M |
| 10,000,000 | 1千万 | 10M |
| 123,456,789 | 1.23亿 | 123.46M |
| 1,000,000,000,000 | 1万亿 | 1T |

These are rounded display labels. A value that rounds over a unit boundary is
promoted, e.g. 999,999 becomes 1M, rather than 1000K. The unit choice is independent of UI language and persists across panel reloads; inaccessible storage falls back to K/M.
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

Desktop validation covered the default K/M display, Chinese unit selection, persistence across panel reopen and a keyboard-accessible full value. English UI and narrow-panel visual checks remain separate; automated unit and component tests cover both unit formats. This is not real-account reconciliation.
