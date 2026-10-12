---
name: date-arithmetic
description: Calculate elapsed time and fixed-duration offsets with explicit dates and time zones. Use for date differences or deadline arithmetic, without creating reminders.
tools: current_time, date_difference, add_date
---

# Date Arithmetic

Use local time tools to answer date questions. These tools calculate values; they do not schedule jobs, send notifications, or create calendar entries.

## Workflow

1. Identify the start, end, requested unit, and time zone. Prefer ISO dates or timestamps with explicit offsets. Clarify ambiguous dates such as 03/04.
2. If “now” is needed, call `current_time`, optionally with the user's IANA `time_zone`. Do not infer the user's zone from the server clock.
3. Use `date_difference` for elapsed duration and `add_date` for fixed-duration offsets. Supported unit names are singular: `millisecond`, `second`, `minute`, `hour`, `day`, `week`. Use the returned result rather than estimating mentally.
4. Present the result with its time zone, unit, and interpretation. Flag a reversed start/end when a negative difference matters.

## Examples

For “How many days between October 1 and October 8, 2026?”, call `date_difference` with `{"start":"2026-10-01T00:00:00Z","end":"2026-10-08T00:00:00Z","unit":"day"}`.

For “Add 48 hours to October 1 at noon UTC”, call `add_date` with `{"date":"2026-10-01T12:00:00Z","amount":48,"unit":"hour"}`.

## Limits

Arithmetic uses fixed durations and UTC instants. A day is 24 hours, not necessarily a local calendar day across daylight-saving changes. Do not promise business-day, holiday, month, or year arithmetic. For inclusive date counting, state that convention separately from elapsed duration. A computed deadline is not a saved reminder.
