---
name: text-cleanup
description: Clean supplied text, normalize whitespace, sort, deduplicate, count or filter lines, and pull out URLs, emails, dates and numbers with local text tools. Use for deterministic edits and list work with visible before/after effects.
tools: text_stats, transform_text, read_note, process_lines, extract_entities
---

# Text Cleanup

Apply only the requested transformations and preserve meaning, identifiers, and punctuation unless the user explicitly asks to change them. Let the tools do exact sorting, counting and deduplication; do not do it mentally.

## Workflow

1. Identify the source text and requested edits. Use `@input` for the entire current input or `@note:<id>` for a saved note; use a literal excerpt if the input also contains instructions.
2. For list work, call `process_lines` with one `operation`: `sort` (natural: 2 before 10), `sort_desc`, `dedupe`, `count` (frequency table), `filter` (needs `match`), or `sample`. `match` narrows any operation; `limit` caps rows.
3. To pull out links, addresses, dates or numbers, call `extract_entities` with `kinds` such as `["emails","urls"]`.
4. For whole-text edits, call `transform_text` with `trim`, `lowercase`, `uppercase`, `collapse_whitespace` or a literal `replace`. Use `text_stats` when size or line counts help verify the edit.
5. Return the result and briefly explain substantive changes. Never chain a truncated preview as if it were the full document.

## Examples

"Which error appears most in this log?" → `process_lines` with `{"text":"@input","operation":"count","match":"error"}`.

"List every email address in this thread" → `extract_entities` with `{"text":"@input","kinds":["emails"]}`.

## Limits

Tools work in memory on bounded input and may return a bounded preview. They do not edit files or save notes. Matching and replacement are literal, not regular expressions. Read a saved note first when its context matters, and never claim it was changed by these read-only tools.
