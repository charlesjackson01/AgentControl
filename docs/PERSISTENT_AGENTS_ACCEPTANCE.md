# Persistent agents: acceptance criteria and regression requirements

**Status:** **Proposed** (N0, 2026-10-03, Opus). It becomes binding for each milestone once the owner approves that
milestone's handoff. §A applies to **every** N milestone. §B is N1's acceptance. §C outlines N2–N7; each milestone's handoff
makes its own section exact before work starts.
Related: `docs/PERSISTENT_AGENTS_ARCHITECTURE.md`, `docs/handoffs/N0_DECISIONS.md`, `docs/handoffs/N1_SHELL_AND_NAVIGATION.md`.

## A. Regression requirements (every N milestone, unless an approved decision says otherwise)

| # | Requirement | How it is shown |
|---|---|---|
| A1 | **Classic** works unchanged at `/classic` and `/classic/`, and classic files are not modified | Classic DOM **82/82**; classic files absent from the diff |
| A2 | **Python suite** passes; environment-gated skips are labelled as gates, never as passes; protected tests change only with authorisation | Full `unittest discover` log. A known race (for example the VM console-log race) is reproduced, run alone, and the full suite re-run; it is never skipped or edited |
| A3 | **Routes:** `/` and `/chat` serve chat; `/classic` and `/classic/` serve classic; root `popout` queries serve classic (C1); security headers stay | `test_chat_routes.py` **4/4**, unchanged |
| A4 | **Approval gates unchanged:** fingerprint revalidation, typed confirmation for critical requests, remember only where the risk allows (one run), deny and redirect, 409 re-read, idempotent duplicate taps; research, skill and team decisions unchanged | The existing approval tests unchanged (`test_permissions.py`, `test_thread_api.py`, `test_conversation.py`, chat T02/T03/T11/T12); the walkthrough's critical-approval step |
| A5 | **The waiting count equals the actionable non-outcome items** at every fully paged checkpoint, and cards equal actions plus outcomes | Walkthrough checkpoints; chat waiting tests |
| A6 | **Privacy:** reasoning is never stored, sent or shown; step material appears only in Turn details; no conversation or memory text in logs or `events` | Privacy assertions carried over; new hostile-content tests |
| A7 | **Security:** the Bearer key on every `/api/*` route; the preview origin is separate and never sees the key; `reply()` headers; **every new rendered field is escaped** | Route and security tests; escaping tests with hostile names (markup, very long strings, RTL controls) |
| A8 | **No new runtime dependencies:** standard-library server; vanilla client; no CDN, web fonts, framework or build step; works offline | Diff review; network log during the matrix shows only same-origin requests |
| A9 | **Accessibility minimums** | Matrix audits: text contrast at least 4.5:1; essential boundaries and focus at least 3:1; targets at least 40×40px on tablet and phone; inputs at least 16px; labelled controls; dialogs with focus trap, Escape and focus return; keyboard order; reduced motion; forced colours; no page overflow at 320px and 390px; text zoom to 200% without clipped controls |
| A10 | **No fabricated content:** no text in an agent's voice unless it is a recorded model output; no seeded or sample records; UI copy names no milestone codes | DOM tests (no sample names; no message elements in empty states) |
| A11 | **Real-server walkthrough:** the accepted eight steps still pass, with per-step GET/POST counts unchanged unless the milestone documents new requests | Walkthrough log and results JSON |
| A12 | **Data safety:** existing rows are never rewritten; migrations are append-only and only as approved; an **older build opens the newer journal** without error (from N2 onwards) | Migration tests; a downgrade check |
| A13 | **One active coding run**, enforced by `Controller.new`, unchanged until N-ORCH; a conversation never blocks or is blocked by it | Existing tests; from N3, non-interference tests |
| A14 | **Isolation of test fixtures:** device and real-server checks use temporary roots and state and a throwaway key; never the owner's projects or state | Fixture assertions (`projects_root` under a temporary prefix; removed on exit) |
| A15 | **Records:** `CURRENT_STATE.md` updated; a completion report with exact results, logs, every replaced assertion (before and after), deviations and anything not done; pushed only to `feature/chat-first-redesign`; no merge into `main` | Review |

## B. N1 acceptance (shell and navigation)

All of §A, plus:

| # | Criterion |
|---|---|
| B1 | The product is still called **AgentControl**. Its rail, and below 720px its bottom bar, list exactly **Primary, Agents, Projects, Workspace, Skills, Settings** in that order, each with an icon and label; the active item has a fill, white text and `aria-current` |
| B2 | **Primary is reachable** from the rail and from the AC mark, labelled "Primary · Everyday", with no team wording; its composer is disabled with the placeholder "Message the primary agent" and a visible reason |
| B3 | **No team catalogue** and no Teams item anywhere |
| B4 | **Projects** contains the existing team thread with unchanged behaviour: timeline, request cards, decision dialogs, waiting strip and pointer, composer (Team chip; no member pills), Session details and the session menu |
| B5 | **Native project switching** (`POST /api/projects/select`, after confirmation) and **creation** (`POST /api/projects/create {name}`, which creates a real folder with git) work. Exactly one POST per activation; refusals shown verbatim; the write lock is respected |
| B6 | **Agents, Workspace, skill assignment and memory** show honest unavailable states. **There is no file list of any kind.** Settings shows the three memory scopes as **separate** rows |
| B7 | **Skills** renders the real library from `GET /api/skills` (escaped) with no POST; it says tool requests use the existing gate, without claiming every request is asked |
| B8 | **Settings** contains Connections (with Check), the Approvals explanation, Memory, Usage and activity links, Appearance, Sign-in (Forget key, with no POST) and the classic link |
| B9 | Every M1–M9 feature listed in N1 handoff §5 is reachable in its new location, and its behaviour tests carry over |
| B10 | `#/`, `#/s/<id>` and `#/w/<run>/<agent>` behave as before (inside Projects). The new section routes work. Switching section never refetches the thread |
| B11 | The **waiting badge** on Projects is visible in every section, and equals the channel waiting count |
| B12 | **Usable at 1280×800 and 390×844** (the handoff), and across the existing matrix (1440, 1200, 1024, 768, 844×390, 320) plus 720 and 719. Every A9 check passes, as do the P-12 footer limits (portrait conversation at least 55% with the bar; landscape at least 45%, idle footer at most 72px, waiting footer at most 112px; bar at most 64px, hidden while the keyboard is open) |
| B13 | The P-11 visual system is applied through tokens: the near-black palette, system font stacks naming Inter and IBM Plex Mono, white active pills and send button. **No mock code** and no CDN |
| B14 | **No backend change:** no `.py` file in the diff. Chat uses only the endpoints listed in N1 handoff §2 |
| B15 | **No approval or security behaviour changed** (A4–A7), demonstrated by the unchanged suites and the walkthrough |

## C. Later milestones (outline; each handoff makes its section exact)

| Milestone | Acceptance outline |
|---|---|
| **N2** Records | Migration `_v8` exactly as approved. Creating an agent adds a library entry and **creates no project**. Exactly one primary record, set up by the user. Specialists store `engine_type` and `display_role`. Project creation (directory inside the root, 1–4 segments, git) **creates the directory, stores membership (at least one specialist; Primary optional) and opens the team thread**. Registering an existing folder works. Skill assignment and tool policy (ask or deny) are stored separately and **can differ on the same skill**. Configure warns per type when the host OpenCode config allows it. Every change is audited with `run = NULL` and no free text. Membership is labelled advisory. The downgrade check passes |
| **N3** Primary and Direct | Migration `_v9`. Replies are text-only through the registry and `Broker` at the lowest priority, with no tool definitions. Recorded replies attributed to the agent and model; reasoning fields discarded; failures without invented text; cancel and retry. **Primary is not cleared by a project switch.** **Direct replies never appear in `/api/thread`, `/api/state`, the team thread or classic.** Non-interference: replies never block `Controller.new`, `control`, `review`, approvals or project switching; at most one pending reply per thread and two in total. Paid endpoints need typed confirmation and count toward the monthly cap. No message text in logs |
| **N4** Memory | Migration `_v10`. Three scopes stored separately and written only by you. Bounds enforced. Deletion removes text, and the audit keeps metadata only. Primary replies use only primary memory; Direct replies use only that specialist's memory. "Send to project" is an explicit, audited copy. **Leakage tests for every pair of scopes.** No combined panel |
| **N5** Binding | Engine exception exactly as approved. Sessions use only project members. The recorded `engine_type` decides tools, and **a reviewer named "Atlas" is never offered `CHANGE_TOOLS`**. Member model, instructions, assigned skills (through the existing trust path) and specialist and project memory apply. **Deny withholds the tool and auto-refuses with an audit entry; ask uses the unchanged gate.** Gates still fire. Old runs are unaffected |
| **N6** Workspace files | A read-only, confined, secret-filtered tree and file endpoint, rooted at the project directory. No symlink escape. No write. Preview uses the existing separate origin and ticket where applicable. Selecting a file does not change the conversation target |
| **N7** Limited allow (optional) | Its own security review. Low and sensitive classes only; **never critical**; re-checked when matched; revocable; audited |

## D. The handoff's acceptance items, by milestone

| Handoff acceptance item | Met in |
|---|---|
| The product is still called AgentControl | N1 |
| Primary is reachable from the rail and not cleared by a project switch | N1 (reachable), N3 (persistent conversation) |
| Creating an agent adds a library entry and does not create a project | N2 |
| Creating a project creates a directory, stores membership and opens the team thread | N1 (folder and thread, name only), N2 (chosen directory and membership) |
| There is no team catalogue | N1 |
| Skill assignment and tool permission can differ on the same skill | N2 (stored), N5 (enforced) |
| Primary, specialist and project memory are separate | N4 (stored and used in replies), N5 (used in sessions) |
| Approval gates still fire; no new orchestrator shipped | Every milestone (A4); N-ORCH is separate |
| Usable at 1280px and 390px | N1 onwards (B12) |
