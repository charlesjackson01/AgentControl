---
name: text-comparison
description: Compare two supplied texts and explain meaningful differences using local diff and comparison tools. Use for revisions between drafts, duplicate checks, or whitespace and case comparisons.
tools: diff_text, compare_text
---

# Text Comparison

Compare two explicit versions and distinguish observed differences from judgments about their meaning.

## Workflow

1. Establish which source is the earlier version and which is the later one. Request a missing version instead of reconstructing it from memory.
2. Use literal strings or `@input`. `@input` refers to the whole run input, not an automatically extracted version.
3. For edits between versions, prefer `diff_text` with `before` and `after`. It aligns the lines, so one inserted line shows as one addition, and returns unified hunks with added, removed and unchanged counts.
4. For a positional line-by-line check, or when case or whitespace must not count, call `compare_text` with `left` and `right`. Set `ignore_case` or `ignore_whitespace` only when the user wants those differences ignored.
5. Report whether the texts match under the selected options, then explain meaningful changes supported by the result and supplied text. Include any tool truncation or output limits in the interpretation.

## Example

Call `diff_text` with `{"before":"Release v1\nStatus: draft\nOwner: Sam","after":"Release v1\nStatus: approved\nOwner: Sam"}` to locate a status change: one line removed, one added, two unchanged.

For an explicitly case-insensitive check, call `compare_text` with `{"left":"READY","right":"ready","ignore_case":true}` and say the texts match ignoring case, not that they are byte-identical.

## Limits

`diff_text` accepts at most 400 lines and 50,000 characters per side, and a long diff may list only its first hunks; diff a smaller section rather than guessing the rest. `compare_text` checks corresponding line positions, not a minimal edit script: inserting one line may make several following positions differ. Each side is limited to 50,000 characters and 3,000 lines; returned differences may be clipped. Neither tool loads repository history, fetches documents, edits either source, or proves semantic equivalence. Ignoring whitespace may hide a significant change in code or structured data; call out that risk when relevant to the user's chosen comparison.
