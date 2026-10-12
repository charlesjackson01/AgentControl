---
name: text-comparison
description: Compare two supplied texts and explain meaningful differences using a local comparison tool. Use for revisions, duplicate checks, or whitespace and case comparisons.
tools: compare_text, read_note
---

# Text Comparison

Compare two explicit versions and distinguish observed differences from judgments about their meaning.

## Workflow

1. Establish which source is the earlier version and which is the later one. Request a missing version instead of reconstructing it from memory.
2. Use literal strings or `@note:<id>` references. Read notes when needed to understand context. `@input` refers to the whole run input, not an automatically extracted version.
3. Call `compare_text` with `left` and `right`. Set `ignore_case` or `ignore_whitespace` only when the user wants those differences ignored.
4. Report whether the texts match under the selected options, then explain meaningful changes supported by the result and supplied text. Include any tool truncation or output limits in the interpretation.

## Example

Call `compare_text` with `{"left":"Release v1\nStatus: draft","right":"Release v1\nStatus: approved"}` to locate a status change.

For an explicitly case-insensitive check, use `{"left":"READY","right":"ready","ignore_case":true}` and say the texts match ignoring case, not that they are byte-identical.

## Limits

The comparison checks corresponding line positions, not a minimal edit script: inserting one line may make several following positions differ. Each side is limited to 50,000 characters and 3,000 lines; returned differences may be clipped. It does not load repository history, fetch documents, edit either source, or prove semantic equivalence. Ignoring whitespace may hide a significant change in code or structured data; call out that risk when relevant to the user's chosen comparison.
