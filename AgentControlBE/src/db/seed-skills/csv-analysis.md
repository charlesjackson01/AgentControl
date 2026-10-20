---
name: csv-analysis
description: Summarize supplied CSV structure, column statistics and per-group totals with a local parser. Use for row counts, column inspection, totals by category, and initial data-quality checks.
tools: csv_summary, calculate
---

# CSV Analysis

Inspect a supplied CSV excerpt or saved note and describe what the available rows show.

## Workflow

1. Establish the delimiter and whether the first row is a header. Pass those options explicitly when known; clarify ambiguous formats.
2. Pass the CSV as a literal string or `@input` to `csv_summary`. Use a literal excerpt when the run input includes explanatory prose.
3. Review the returned row and column information: blank, numeric and nonnumeric counts, `distinct` values, the most frequent `top_values` (omitted when every value is unique), min, max, mean and median for numbers, and any parse errors. Base conclusions on fields actually returned by the tool.
4. For totals by category, set `group_by` to a column name (or 1-based position) and `sum_column` to a numeric column. Groups come back sorted by row count with their sums, at most 20, with the rest combined under `other`; `sum_skipped` counts blank or nonnumeric cells. `sum_column` alone returns `sum_total`.
5. For shares, ratios or differences between returned numbers, call `calculate` instead of computing mentally.
6. Report the scope, important patterns, and data-quality concerns. Distinguish empty cells, nonnumeric strings, and zero; do not silently treat them as the same value.

## Example

Call `csv_summary` with `{"csv":"item,quantity\npen,3\nbook,2","delimiter":",","has_header":true}`. Describe the two data rows and the numeric summary for quantity that the tool returns.

For "Sales by region?", call `csv_summary` with `{"csv":"@input","group_by":"region","sum_column":"sales"}`, then `calculate` with `{"expression":"round(160.5 / 255.5 * 100, 1)"}` for one region's share of the returned total.

For semicolon-separated content, set `"delimiter":";"`. For a headerless file, set `"has_header":false` rather than discarding the first data row.

## Limits

The tool processes bounded local text (50,000 characters, 1,000 rows, 100 columns), not uploaded binary spreadsheets, remote URLs, or a database. It does not execute formulas or modify records. Do not infer population-level conclusions from an excerpt. Preserve quoted cells and avoid manually splitting CSV on commas because quoted fields may contain delimiters or newlines.
