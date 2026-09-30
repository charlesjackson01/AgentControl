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
