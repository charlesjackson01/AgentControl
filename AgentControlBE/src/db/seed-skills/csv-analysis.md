---
name: csv-analysis
description: Summarize supplied CSV structure and numeric columns with a local parser. Use for row counts, column inspection, and initial data-quality checks.
tools: csv_summary, read_note
---

# CSV Analysis

Inspect a supplied CSV excerpt or saved note and describe what the available rows show.

## Workflow

1. Establish the delimiter and whether the first row is a header. Pass those options explicitly when known; clarify ambiguous formats.
2. Pass the CSV as a literal string, `@input`, or `@note:<id>` to `csv_summary`. Use a literal excerpt when the run input includes explanatory prose.
3. Review the returned row and column information and any numeric summaries or parse errors. Base conclusions on fields actually returned by the tool.
4. Report the scope, important patterns, and data-quality concerns. Distinguish empty cells, nonnumeric strings, and zero; do not silently treat them as the same value.

## Example

Call `csv_summary` with `{"csv":"item,quantity\npen,3\nbook,2","delimiter":",","has_header":true}`. Describe the two data rows and the numeric summary for quantity that the tool returns.

For semicolon-separated content, set `"delimiter":";"`. For a headerless file, set `"has_header":false` rather than discarding the first data row.

## Limits

The tool processes bounded local text, not uploaded binary spreadsheets, remote URLs, or a database. It does not execute formulas or modify records. Do not infer population-level conclusions from an excerpt. Preserve quoted cells and avoid manually splitting CSV on commas because quoted fields may contain delimiters or newlines.
