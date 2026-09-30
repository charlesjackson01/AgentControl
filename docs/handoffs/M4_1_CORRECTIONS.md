# Handoff M4.1: Composer corrections

**From:** Opus (architecture review) → **To:** Codex (implementation)
**Branch:** `feature/chat-first-redesign`. Commit and push only there; **never merge into `main`**.
**Size:** small (a few hours). **Must land before M4 is accepted and before M5.** It is independent of
`M5_0_ACTIONABILITY.md`; the only shared file is `thread.js` (one empty-state line here, one label there).
**Read first:**
1. the review at the end of `docs/handoffs/M4_COMPOSER.md`
2. `docs/REDESIGN_ARCHITECTURE.md` §3 and §7

Fix exactly the items below. Frontend only: **no server, schema, classic or orchestration change.** Correct the
M4 tests that asserted the defective behaviour. Do not weaken any other test.

---

## 1. Never resend a previous session's title or goal checks

**Now:** after a successful start, `submit()` writes the whole `settings` object to `acx-settings`. `settingKeys`
includes `title` and `goal_checks`, and `settings` is not reset within the page either. The next session silently
sends the previous title and acceptance criteria.

**Required:**
- Split per-session fields from remembered preferences:
  - **Per-session, never remembered or reused:** `title`, `goal_checks` and `allow_dirty`. They start empty for every
    new session and follow-up. They are cleared after each successful `POST /api/runs`, and when follow-up mode is cancelled.
  - **Remembered preferences** (handoff §2.8, exactly): `verifier`, `max_steps`, `run_minutes`, `mode`, `team_size`,
    `isolation`, `network` (never `internet`), `cpus`, `memory_gb`, `setup` and `preview`.
- `acx-settings` stores **only** the remembered keys. On load, drop any other key found in storage (for example a
  `title` or `goal_checks` written by M4).
- **Tests:**
  - After a successful session with a title and a goal check, the next new session's body has **no** `title` and no
    `goal_checks`, both in the same page and after reload.
  - `acx-settings` never contains `title`, `goal_checks` or `allow_dirty`.
  - A stored `acx-settings` containing them is cleaned on load, and they are not sent.
  - Replace the M4 assertion that the title is remembered.

## 2. Follow-up must not leak into new sessions

**Now:** "Reply in session" merges the parent's `verifier`, `max_steps` and `mode` into the shared `settings`.
Cancelling the follow-up keeps them.

**Required:**
- Follow-up values live in a separate follow-up overlay, applied only to the follow-up body.
- **Cancel** (✕ or Escape) discards the overlay and restores the preferences exactly as they were.
- **After a successful follow-up,** the remembered preferences are updated only with values the user **changed in the
  Settings sheet** during that follow-up. The parent's inherited values are not stored as preferences.
- **Test:** a remembered verifier V1; a follow-up whose parent has V2 sends V2; cancelling, then starting a new session, sends V1.

## 3. Mentions: only a leading `@agent` targets; everything else is literal

**Now:** any `@word` is parsed as a mention. Unknown names block sending ("Pin @types/node" cannot be sent), and
every known mention is stripped, so "Ask @coder-2 to sync with @coder-1" is sent as "Ask  to sync with ".

**Required (this corrects M4 handoff §3's "Mentions" rules):**
- A note targets an agent **only** when the draft **starts** with `@name` followed by whitespace or the end of the
  text, and `name` is one of the active session's non-orchestrator agents. That leading token and one following
  space are removed from the sent `text`, and `agent: name` is sent. **Nothing else in the text changes.**
- Every other `@word` (in the middle, unknown, or like `@types/node` or `@pytest.fixture`) is **literal text**. It never
  produces an error, is never stripped, and never changes the target.
- A leading `@unknown` is literal text to Hermes; no error. The target chip already shows "Note → Hermes", so the
  target is visible before sending.
- **Suggestions:** typing `@` **at the start of the draft** opens the agent list. Choosing an agent replaces the
  leading token. Typing `@` elsewhere opens nothing.
- **Tests:**
  - "Pin @types/node to v20" and "Use the @pytest.fixture decorator" send verbatim to Hermes.
  - "Ask @coder-2 to sync with @coder-1 on the schema" sends verbatim to Hermes, with no `agent`.
  - "@coder-2 keep it simple" sends `{text:'keep it simple', agent:'coder-2'}`.
  - "@nobody hello" sends verbatim to Hermes.
  - The chip follows the same rule while typing.
  - Replace the M4 "last @agent wins" and "unknown mention error" assertions.

## 4. Empty-room copy

**Now:** the empty room says "Start a session in classic", although the composer starts sessions.

**Required:** the empty state reads "A room for your project" / "Write a goal below to start the first session."
with **no** classic link. Change `thread.js`'s empty-state line only. Update any test that asserted the old text.

## 5. Optional, only if trivial

- On a network failure (no HTTP response), show: "Couldn't reach AgentControl. The request may or may not have been
  recorded. Check the room before sending again." Keep the draft, as today.
- Close the session menu when the Stop dialog opens.

## 6. Acceptance

1. `python3 -m unittest discover -s agent-autonomy/tests` passes; M4.1 changes no Python. Report skipped tests by name.
   An unchanged timing-sensitive backend test that fails intermittently is rerun and recorded, never modified.
2. `test_ui.cjs` passes 82/82. `test_chat_ui.cjs` passes (the M4 tests corrected as stated, plus the new ones).
   `chat_screenshots.cjs` passes, and the phone footer budgets still hold.
3. The diff touches only `agent-autonomy/chat/composer.js`, `thread.js` (the empty state only), optionally `shell.js`
   (the menu close), `tests/test_chat_ui.cjs`, `tests/chat_screenshots.cjs` if needed, `CURRENT_STATE.md`, this file
   and the architecture change log.
4. Add to the architecture change log: "M4.1: only a leading @agent targets a note; other @words are literal. Title,
   goal checks and allow_dirty are per-session and never remembered."

## 7. When you finish

1. Append a completion report to this file: the changes, test commands and counts (with skipped tests named), and the screenshots reviewed.
2. Set M4.1 to done in `CURRENT_STATE.md`, then push. No PR and no merge unless the owner asks.

---

## M4.1 completion report — Codex, 2026-09-30

### Changes and scope

Verified `/home/charlesjackson/AgentControl` on `feature/chat-first-redesign`, with a clean working tree.
`git pull --ff-only origin feature/chat-first-redesign` advanced `30e83f2` to the expected `7ee8528`.
Read `CURRENT_STATE.md`, the architecture contract and this handoff in order, then the M4 review.

Separated remembered preferences, per-session fields and the follow-up overlay in `composer.js`.
`acx-settings` now stores exactly the eleven keys in §1, with `network:'internet'` excluded; loading rewrites
legacy storage without title, checks, dirty acknowledgement or other unsupported keys. A session's title
and checks remain available on a failed start, then clear after a successful start. Title, checks and dirty
acknowledgement begin empty on entering a follow-up and clear on cancellation or successful creation.

Parent verifier, turn limit and mode stay in the follow-up overlay. Cancel and Escape discard it without
changing the prior preferences or draft. Successful follow-ups remember only preference values explicitly
edited in their Settings sheet, including removing a preview; inherited defaults are not remembered.
The submitted changes are captured before the POST, independently of the subsequent server refresh.

Routing now examines the raw draft's leading token only. A valid active non-orchestrator agent followed by
whitespace or end of text selects the recipient; only that token and one separator are consumed.
Everything else is sent unchanged, including later agents, unknown names, package/decorator strings,
newlines and extra whitespace. The target chip and placeholder use the same rule. Suggestions open only
for a token at the start and replace that token when chosen. Unknown tokens are ordinary Hermes notes.

Changed only the empty-state line in `thread.js`: “A room for your project” / “Write a goal below to start
the first session.” It has no classic start link or fabricated message. Added the required architecture
change-log entry. No backend, API, schema, journal, engine, lifecycle, approval, research, skill, classic UI,
CSS or endpoint/request-shape change. D7 was unused; M5.0 and M5 remain unstarted.

### Defect reproduction and regressions

Corrected the three M4 assertions that required remembering the title, last-mention routing and an error
for an unknown mention. All other existing tests are retained. Added ten regressions covering:

- Consecutive starts in one page and after reload without reusing title/checks; exact storage whitelist and legacy cleanup.
- Draft/title/check retention on a failed start, successful retry and per-session reset.
- Both follow-up cancellation paths restoring prior preferences and clearing per-session fields/dirty acknowledgement.
- Unedited follow-ups sending parent defaults without saving them; edited follow-ups remembering only explicit changes.
- Fresh per-session fields when entering a follow-up.
- Verbatim package/decorator, middle, unknown and later mentions; leading-only chip/placeholder/routing and whitespace preservation.
- Suggestions at the start only, and the exact empty-room copy with no classic link or fake messages.

Demonstrated the final tests against a temporary copy of the **unchanged `7ee8528` frontend** under
`/tmp/ac-m41-baseline`, without replacing repository files. The result was **64/77 passing**: all ten new
regressions and the three corrected M4 assertions failed. The other 64 passed. Against the corrected
frontend, **77/77 pass**. Evidence: `/tmp/ac-m41-before-final.log` and `/tmp/ac-m41-chat.log`.

### Required verification

| Command | Result |
|---|---|
| `python3 -m unittest discover -s agent-autonomy/tests` | **398 tests, OK (skipped=3)**, 250.564 s; no timing-sensitive failure in this run |
| `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_ui.cjs` | **82/82 passed**, unchanged classic suite |
| `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_chat_ui.cjs` | **77/77 passed** |
| `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/chat_screenshots.cjs /tmp/chat-shots-m41` | **108 combinations + 4 regressions passed**, 158 temporary screenshots |
| `git diff --check` | passed |

The environment skips were:

- `test_container_e2e.ContainerRunE2E.test_agent_works_in_a_locked_down_container`: container opt-in/runtime/image gate.
- `test_preview.DesktopTests.test_desktop_preview_shows_frames_and_accepts_input`: desktop display tools gate.
- `test_vm_e2e.VMRunE2E.test_agent_works_in_a_kvm_clone`: VM opt-in/KVM gate.

The OpenCode trio ran and passed. Python/socket tests and Chromium ran outside the sandbox. Logs are
`/tmp/ac-python-verified.log`, `/tmp/ac-m41-classic.log`, `/tmp/ac-m41-chat.log` and `/tmp/ac-m41-browser.log`.
The retained tests verify server-only message appearance, failure drafts, duplicate-send protection,
in-flight controls, Basic/Advanced behavior, endpoint bodies and M3/M3.1 ordering/disclosure/revalidation.

### Rendering inspected

Added browser cases for literal notes, leading targeted notes, cleaned legacy Settings and restored Settings
after cancelling a follow-up, across desktop/laptop/phone and light/dark. Existing cases and regressions remain.
No horizontal overflow or page errors occurred. At **390 × 844**, light and dark:

| State | Footer | Waiting row | Timeline | Viewport retained |
|---|---:|---:|---:|---:|
| Idle, no waiting | **57 px** (limit 72) | absent | **683.5 px** | **81.0%** |
| With waiting | **105 px** (limit 120) | **40 px** | **635.5 px** | **75.3%** |

Inspected actual screenshots in `/tmp/chat-shots-m41`:

- `composerIdle-desktop-light.png` and `composerIdle-phone-dark.png`: corrected copy and compact footer.
- `composerLiteral-phone-light.png`: intact “Pin @types/node to v20” with the Hermes target.
- `composerTarget-phone-dark.png`: visible leading `@coder-2` target.
- `composerRestored-desktop-light.png`: verifier V1 restored after cancelling, empty title/checks, Advanced collapsed.
- `composerCleanSettings-phone-dark.png`: cleaned legacy fields in the phone bottom sheet.

Measurements are in `/tmp/chat-shots-m41/footer-measurements.json`. Growth limits and the 480 px reduced
visual-viewport check still pass. Native phone OS keyboard verification remains deferred to M8 as reviewed.

### Deviations and unresolved issues

No deviation or unresolved required M4.1 issue. The optional network-error wording and session-menu closure
from §5 remain unchanged. M3 accessibility deferrals and the documented research/skill actionability mismatch
remain unchanged; this task did not implement M5.0, use D7 or begin M5. M4.1 is ready for review.
