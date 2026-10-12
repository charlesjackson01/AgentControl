---
name: text-cleanup
description: Clean supplied text, normalize whitespace, or sort and deduplicate lines with local text tools. Use for deterministic edits with visible before/after effects.
tools: text_stats, transform_text, read_note
---

# Text Cleanup

Apply only the requested transformations and preserve meaning, identifiers, and punctuation unless the user explicitly asks to change them.

## Workflow

1. Identify the source text and requested edits. Use `@input` for the entire current input or `@note:<id>` for a saved note; use a literal excerpt if the input also contains instructions.
2. Use `text_stats` when size or line counts help verify the edit.
3. Call `transform_text` with one supported operation: `trim`, `lowercase`, `uppercase`, `collapse_whitespace`, `sort_lines`, `dedupe_lines`, or `replace`. Chain calls by passing the previous returned text as the next literal input only when the result is complete. Do not chain a truncated preview as if it were the full document.
4. Return the transformed text and briefly explain substantive changes. Verify that sorting, deduplication, or collapsed whitespace did not remove structure the user needed.

## Example

User: “Remove duplicate lines from this list: pear, apple, pear” (one item per line).

Call `transform_text` with `{"text":"pear\napple\npear","operation":"dedupe_lines"}`. If the user also wants alphabetical ordering, pass the returned text into a second call with `"operation":"sort_lines"`.

For a literal replacement, use `{"text":"draft v1","operation":"replace","find":"v1","replacement":"v2"}`.

## Limits

Tools process at most 50,000 input characters in memory and may return a bounded preview. They do not edit files or save notes. Replacement is literal, not a regular expression. Whole-text whitespace collapse can remove intentional line breaks; do not use it for structured text without considering that effect. Read a saved note first when its context matters, and never claim it was changed by these read-only tools.
