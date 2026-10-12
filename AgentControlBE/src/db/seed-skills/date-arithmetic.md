---
name: date-arithmetic
description: Resolve date phrases and calculate elapsed time or offsets with explicit dates and time zones. Use for deadlines, "next Friday", month-end dates, business days or date differences, without creating reminders.
tools: current_time, date_difference, add_date, resolve_date
---

# Date Arithmetic

Use local time tools to answer date questions instead of estimating. These tools calculate values; they do not schedule jobs, send notifications, or create calendar entries.

## Workflow

1. Identify the start, end, requested unit, and time zone. Clarify ambiguous dates such as 03/04.
2. Turn any date phrase into an exact date with `resolve_date`: today, next friday, in 3 days, 2 weeks ago, 10 business days, end of month, March 5, or ISO. Pass `from` for a phrase relative to another date and `time_zone` for the user's IANA zone.
3. If only "now" is needed, call `current_time`, optionally with `time_zone`. Do not infer the user's zone from the server clock.
4. Use `date_difference` for elapsed duration and `add_date` for fixed-duration offsets (singular units: `millisecond`, `second`, `minute`, `hour`, `day`, `week`). For months, quarters or years, use `resolve_date` ("in 2 months"), which clamps to the end of shorter months.
5. Present the result with its time zone and interpretation. Flag a reversed start/end when a negative difference matters.

## Examples

For "What date is 10 business days after March 2, 2027?", call `resolve_date` with `{"expression":"10 business days","from":"2027-03-02"}`.

For "How many days between October 1 and October 8, 2026?", call `date_difference` with `{"start":"2026-10-01T00:00:00Z","end":"2026-10-08T00:00:00Z","unit":"day"}`.

## Limits

Business days skip weekends only, not holidays. `add_date` and `date_difference` use fixed durations: a day is 24 hours, not always a local calendar day across daylight-saving changes. For inclusive date counting, state that convention separately from elapsed duration. A computed deadline is not a saved reminder.
