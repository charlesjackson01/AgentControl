# Skills library recovery

## Recovered state

The initial checkout was a clean `work` branch at `5f46be2`, identical to
`origin/master`, with one worktree and no uncommitted changes or unreachable
commits. `HANDOFF.md` described PR #2, not the interrupted expansion. The
baseline passed 60 backend tests and both typechecks; frontend lint/build passed.

Remote inspection recovered `feat/skills-library-tools` at `af38617`, the head
of [PR #3](https://github.com/charlesjackson01/AgentControl/pull/3). Its five
commits already implemented temperature handling, endpoint deletion
confirmation, legacy skill backfills, SKILL.md tool lists, and registry/notes
plumbing. All 98 tests at that head passed. None of those commits were reset or
recreated; work continued on that feature branch.

The recovered workspace module contained `list_agents`, `list_skills`, and
`read_run_log`. The other five category modules were empty arrays. Only the
six vendored seed skills existed. The picker, editable chips, and Notes page
were absent. The later uncommitted edits, fake model server, and 38-decision
reference shown in the interrupted-session screenshot were not available in
the repository. Consequently the new tools and skills below complete the
stated scope using the recovered contracts; they do not claim to reproduce
unavailable drafts or to establish why the earlier workflow agents failed.

## Finished inventory

| Module | Tools |
| --- | --- |
| Workspace | `list_agents`, `list_skills`, `read_run_log` |
| Notes | `list_notes`, `read_note`, `save_note` |
| Time | `current_time`, `date_difference`, `add_date` |
| Math | `calculate`, `convert_units` |
| Text | `text_stats`, `transform_text`, `compare_text` |
| Data | `json_query`, `csv_summary` |

The ten new skills are `calculation-checker`, `unit-conversion`,
`date-arithmetic`, `text-cleanup`, `text-comparison`, `json-inspection`,
`csv-analysis`, `notes-organizer`, `meeting-notes`, and `workspace-audit`.
All six vendored bodies remain byte-identical, enforced by their existing hash
test. Their existing declarations remain unchanged. New skills resolve actual
registry declarations and import through the public API. Migration tests cover
six-to-sixteen upgrades, edited content, cleared tools, deleted seeds, and
restart idempotence.

The frontend provides registry search/selection, removable tool chips, a
16-tool selection limit, comment-aware SKILL.md previews, and preservation of
unknown legacy declarations. Editing without changing tools omits the field
to preserve existing data. Notes supports search over visible summaries,
full-body reading, and confirmed deletion with error/retry behavior. Note
bodies render as text, not HTML. Existing temperature and endpoint-confirmation
implementations are retained.

## Review and fixes

- Arithmetic uses a bounded parser, without evaluation or function execution.
  Unit conversion rejects incompatible dimensions. Date arithmetic requires
  valid ISO values and explicit timestamp offsets; a day always means 24 hours.
- JSON paths inspect own properties only and cannot evaluate expressions.
  CSV handles escaped quotes, delimiters, multiline cells, malformed input,
  and row/column/field caps. Text replacements are literal; underscores are
  preserved unless explicitly targeted. Tests cover these boundaries.
- Notes enforce author-only replacement, append semantics, per-run write caps,
  body/title/tag limits, duplicate titles, and workspace capacity. `@note:`
  references enforce read permission. Saves and deletes restore memory on
  persistence failure; atomic workspace replacement prevents partial writes
  and publishing changes before a failed vault save.
- Review found configured secrets with JSON-escaped quotes/backslashes/newlines
  could survive result redaction, and short configured secrets were excluded.
  Both forms and all nonempty configured secrets are now covered by tests.
- Review found escape-heavy JSON previews could exceed their declared budget.
  Fallback previews now measure serialized size. Recovery error messages are
  capped, and the run's 4,000-character ceiling includes its truncation marker.
  `list_skills` keeps the expanded seeded catalog compact enough to
  survive the run message budget as valid JSON.
- Frontmatter parsing ignores comments before keys and after values/list items,
  preserves quoted hashes, and keeps tools blocks open across blank/comment
  lines. Frontend/backend parity tests cover the same cases. The screenshot's
  exact underscore/message fixes were unavailable; these regression cases were
  verified directly rather than inferred from workflow completion labels.
- Seed review corrected unsupported duration-conversion language and made date
  examples match singular schema enum values. Skills state their local/offline
  limits and do not pretend to send messages, delegate, or schedule tasks.
- The backend build now copies seeds using Node instead of Windows-only `xcopy`.
  CI also runs the backend build and new frontend tests.

## Verification

From the repository root:

```sh
cd AgentControlBE
npm run typecheck && npm test && npm run build
cd ../AgentControlFE
npm run lint && npm run typecheck && npm test && npm run build
```

Verified locally: backend 187 tests pass; backend typecheck/build and frontend
lint/typecheck/tests/build pass. Frontend tests contain 15 test cases across
two files (the sandbox's Node runner reports the two files;
direct execution reports all 15 cases). Backend persistence-failure tests
intentionally log failed writes. They do not use real model services.

Browser smoke passed against the built backend, Vite, Chromium, and an isolated
scripted OpenAI-compatible server:

```sh
# Requires Python playwright and Chromium; all services bind loopback only.
python3 scripts/smoke.py --artifacts /tmp/agentcontrol-smoke
```

It verified registry selection/removal and saving, editing with an unknown
legacy declaration preserved, SKILL.md preview/import agreement, real agent
`calculate` and `save_note` exchanges, persisted run audit entries, Notes
search/detail, literal rendering of HTML-like note content, deletion cancel,
simulated 500/retry, confirmed deletion, and endpoint deletion confirmation.
All checks passed with zero browser page errors and exactly four scripted
model requests. The script cleans its processes and temporary workspace and
writes screenshots plus logs to the artifact directory. No real endpoint was
contacted. `git diff --check` also passed.

## Limits

Tools run in-process with bounded inputs, not a sandbox for arbitrary code.
They cannot access the network, filesystem, or shell. Math uses JavaScript
numbers, not exact decimal accounting. Text comparison is positional by line,
not a minimal edit script. Large results can be truncated and are marked.
The run budget is a character-based estimate, not a model tokenizer.

Notes are shared workspace data, not per-user access-controlled documents.
Only API bearer authentication provides the existing workspace boundary.
Deleting an agent does not delete its notes; another agent may append but may
not replace the departed author's note. Store/vault writes are not one atomic
transaction, although failed note persistence no longer publishes a workspace
snapshot. Tests and the scripted browser model establish integration, not
real-model tool-selection quality or production endpoint reachability.
