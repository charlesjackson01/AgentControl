# M9 Part A parity checklist

**Audit date:** 2026-10-02. **Product audited:** `568534e` (separate M9 Part 0 N1 commit), on
`feature/chat-first-redesign`. This is an audit, not owner parity sign-off or a route cutover.

| Status | Rows |
|---|---:|
| Native | 17 |
| Linked to classic | 54 |
| Intentionally not ported | 1 |
| Missing | 0 |

**Total: 72 rows.** All 15 README bullets, 12 classic views/navigation surfaces, all M5 §2.7
capabilities, six interactive-surface facets, further classic-only actions, and explicit native subsets are covered.
Counts include deliberate overlapping feature/view/facet rows; they are not unique backend-capability counts.

**Missing:** none found with the documented classic fallbacks available. This does not mean full native parity.
The owner must decide whether the linked functionality is sufficient for G1. Physical-device behavior is not
classified as verified by this browser audit; G3 remains pending.

**Linked to classic (complete row list):**

- README “What you see” — all 15 bullets: R02 Live OpenCode terminal, including `t` full screen; R04 Project tab / live preview; R08 Skills, including library and removal; R09 Virtual machines; R11 Optional paid models; R12 Mission control; R13 Containers; R14 Model server.
- Every classic view and named navigation surface: V01 Mission; V02 Workspace; V03 Runs; V04 Approvals; V05 Activity; V06 New run; V07 Project; V08 Skills; V09 Usage; V10 Settings; V11 Switch project; V12 Classic keyboard shortcuts.
- M5 §2.7 functionality retained in classic: D01 Rule revocation; D02 Paid models and spend controls; D03 Stuck watch; D04 Internet during work; D05 Skill removal / rollback; D06 Propose a library skill; D07 Propose a git skill source; D08 Preview lifecycle/configuration controls; D09 Container lifecycle/resource controls; D10 VM lifecycle controls.
- Interactive surfaces — each retained in the classic pop-out: S01 Web/static preview frame and one-time ticket; S02 Program terminal and typed input; S03 VM screen/frame and console input; S04 Desktop frame and mouse/text/key input; S05 Generic/provider surface frames and input; S06 Surface picker/expand and special key controls.
- Further classic-only functionality (source/action inventory): C01 Full decision history and hash-chain audit browser; C02 Required review too large/unsupported for room; C03 All-project run history and run search; C04 Full raw Activity and search/filter; C05 Recorded diff download; C06 Workspace tabs, split panes and movable/resizable windows; C07 Standalone pop-out relaying across classic windows; C08 Full agent state-history view; C09 Detailed model queue, slots, per-agent token/spend tables; C10 Remaining time/turn budget and detailed run summaries; C11 Saved goal-check list and evidence panel; C12 Ask for a status draft template; C13 Browser notification opt-in/out; C14 Explicit Forget key / sign out control; C15 Project folder browsing and creation; C16 Terminal Copy and full-screen toggle; C17 Verify while paused/interrupted/attention and full on-demand command/output panel; C18 Built-in example brief and full classic help/onboarding.

**Link navigation matters.** The six More items all have the exact href `/classic`. They do not deep-link
or select their named classic views. After following one, select that view in classic. Composer fallback links
also use `/classic`. Workspace's **Open in classic pop-out** currently has the exact href
`/?popout=<encoded agent>&run=<encoded session>`; it opens a standalone classic view today because `/` still
serves classic. Part B must later change it, under the gates. “Linked” never means native in this document.

Product paths in tables are relative to `agent-autonomy/` unless another root is named. Evidence codes are
expanded below into exact passing test names and actual screenshot/real-server paths. No product/test file
changes are made in Part A.

## README “What you see” — all 15 bullets

| ID / feature | Classic location | Chat location | Status | Evidence | Notes |
|---|---|---|---|---|---|
| R01 · Turns rail and workflow board | Runs → turn rail / Plan, Prompt, Code, Verify (`index.html:109–127`) | `#/w/<run>/<agent>` → turn toolbar and stages | Native | T01 + W5 / IMG01 | Vertical stages replace the horizontal classic board; exact classic stage-state semantics retained. |
| R02 · Live OpenCode terminal, including `t` full screen | Runs → Code terminal / `t` (`index.html:120`) | Open in classic pop-out; More → Classic dashboard → Runs for `t`; native terminal in N01 | Linked to classic | P1, P2, L1; classic “terminal appends new output without rebuilding earlier lines” | Native streaming/follow is present. The advertised `t` full-screen and Copy actions remain classic. |
| R03 · Approvals | Approvals; banner/terminal Review (`index.html:136`) | Room request cards → Approve once / Deny / question answers | Native | T02, T03 + W2–W3 / IMG02 | One room card and a waiting pointer replace repeated classic banners. R0–R3, typed critical confirmation and backend hash-chained auditing hold. Audit browsing/revocation: C01, D01. Oversized/unsupported review: C02. |
| R04 · Project tab / live preview | Project (`index.html:140–176`) | Open in classic pop-out; More → Classic dashboard → Project | Linked to classic | P2, L1; classic preview/W6 tests | Chat configures a launch preview and shows recorded surface metadata; viewing, tickets and input are classic. |
| R05 · Runs on their own branch; Apply | Runs → branch panel / outcome (`app.js:2072–2080`) | Room outcome → Verify now / Apply / Discard / Reply | Native | T04, T05 + W6–W8 / IMG03 | Existing branch, merge-commit and post-merge verification semantics unchanged. Apply/Discard require confirmation; newest terminal outcome follows the accepted M2.1 rule. |
| R06 · Team runs | New run → Team; Runs/Mission → team plan/tasks | Settings → Team; room proposal; Team panel; agent Workspaces | Native | T06, T07 + W4–W5 / IMG04 | Only recorded members appear running; never-approved rosters stay proposed, including stopping/finished sessions. Decisions remain in room cards. |
| R07 · Auto mode | New run → Auto explanation (`app.js:1786`) | Composer Settings → Auto → server explanation | Native | T08 + E1 / IMG05 | Uses existing mode preview and `mode:auto` request. A resulting team still needs approval. E1 demonstrates preview; exact Auto start body is covered by T08. |
| R08 · Skills, including library and removal | Skills library/history; Runs → skills panel (`app.js:1261–1288`) | More → Skills → select Skills/Run; native decisions N09 | Linked to classic | L1, L2; classic “run skills panel lists installs, removes them, and adds from the library or git” | Fetch/reject/install reviews are native. Proposing library/git sources, removal and full history remain classic. |
| R09 · Virtual machines | New run → VM; Runs → VM controls; Project / Workspace screen | More → Classic dashboard → Runs; Open in classic pop-out | Linked to classic | L1, L2, P2; classic VM and W6 tests | Chat can select VM isolation if available. Lifecycle, console and input remain classic; no physical/KVM execution is claimed by this audit. |
| R10 · Specialists | Runs/Mission → tester/reviewer/researcher; Workspace logs | Recorded members/turns; research room card; `#/w/...` | Native | T09, T10 + IMG06 / IMG07 | Server chooses specialists. Tester merge restrictions and reviewer read-only execution unchanged. Research uses typed approval and recorded reports; no fabricated live Hermes/research stream. |
| R11 · Optional paid models | New run → role models; Runs → cap controls; Usage | Settings → classic dashboard; More → Usage → Usage | Linked to classic | L1, L2; classic paid-model/Usage tests | Paid role choice, typed consent, spend cap, cap raise/local fallback and token/spend reports remain classic. |
| R12 · Mission control | Mission (`index.html:102–106`) | More → Classic dashboard → Mission; native members/tasks N07 | Linked to classic | L1; classic “mission shows every agent live, the task graph, and the model queue” | Chat has roster/presence/tasks/turn links. Full agent output/token cards, model queue and classic dashboard/bottom tabs remain classic. |
| R13 · Containers | New run → container; Runs → resource controls; Project desktop | More → Classic dashboard → Runs; Open in classic pop-out | Linked to classic | L1, L2, P2; classic container tests | Authorized launch isolation/setup/CPU/memory/network setup-or-none settings are native. Detailed lifecycle/resources, internet during work and clickable desktop remain classic. |
| R14 · Model server | Connections; Mission → model queue; Usage; `state/models.json` | More → Usage / Classic dashboard; native Connections N08 | Linked to classic | L1; classic model-server/Mission tests | Native service health/checks do not reproduce queue/slot/token accounting. File-based model/gateway configuration remains as before; no chat model CRUD is claimed. |
| R15 · Themes | Toolbar → Mac / Terminal / XP (`index.html:82`) | System light/dark tokens; no theme picker | Intentionally not ported | Architecture D4 and §9; “tokens and isolation guards” | D4 explicitly excludes the classic theme system. Classic themes remain available in classic; this row does not count as a native port. |

## Every classic view and named navigation surface

| ID / feature | Classic location | Chat location | Status | Evidence | Notes |
|---|---|---|---|---|---|
| V01 · Mission | Mission (`index.html:63,102`) | More → Classic dashboard → Mission | Linked to classic | L1 | Native roster/task subset: R06/N07. Full dashboard remains classic. |
| V02 · Workspace | Workspace (`index.html:64,89`) | Open in classic pop-out; native read-only `#/w/...` N02 | Linked to classic | P1, P2 | Full classic Workspace includes tabs/splits/windows and surface controls. Native inspection is read-only. |
| V03 · Runs | Runs (`index.html:65,107`) | More → Classic dashboard → Runs | Linked to classic | L1 | Native sessions/history/outcomes are in the room/rail. Filters, detailed resource/budget/check panels and full summaries remain classic. |
| V04 · Approvals | Approvals (`index.html:66,136`) | More → Classic dashboard → Approvals | Linked to classic | L1; T11 | Decisions are native R03. Remembered rules, full decision history/audit and truncated-review fallback remain classic. |
| V05 · Activity | Activity (`index.html:67,137`) | More → Activity → select Activity | Linked to classic | L1 | Full events/search/filter and Hermes request prompts remain classic. Room folds/omits events; Workspace logs are bounded selections. |
| V06 · New run | New run dialog (`index.html:186–244`) | Settings → classic dashboard → New run; native composer N03/N05 | Linked to classic | L2 | Most start settings are native. Complete dialog includes paid models, stuck watch and internet-during-work, which remain classic. |
| V07 · Project | Project (`index.html:68,140`) | More → Classic dashboard → Project; Open in classic pop-out | Linked to classic | L1, P2 | Interactive preview and lifecycle controls remain classic. |
| V08 · Skills | Skills (`index.html:69,139`) | More → Skills → select Skills | Linked to classic | L1 | Library and install/removal history live here; proposing/removing a run skill uses classic Runs. |
| V09 · Usage | Usage (`index.html:70,138`) | More → Usage → select Usage | Linked to classic | L1 | Periods, tokens and spend by run/agent/model remain classic. |
| V10 · Settings | Distributed: New run, Project preview config, Connections, theme toolbar | More → Settings → classic dashboard; composer subset N05 | Linked to classic | L1, L2 | Classic has no single Settings view. More → Settings is a generic link; choose the relevant classic control. |
| V11 · Switch project | Project name → browse/use/create (`index.html:62,271`) | More → Switch project → click classic project name | Linked to classic | L1; classic “projects: browse, switch, create, and history per project” | No native switch/create action; classic opens its project dialog after the user clicks the project name. |
| V12 · Classic keyboard shortcuts | Help; `app.js:2129–2145`, `workspace.js:743+` | More → Classic dashboard; Workspace shortcuts in pop-out | Linked to classic | L1, P1; classic shortcuts/help tests | Classic `a/d/p/x/v/t/?`, `1–9`, `[`, `]`, `\`, `o` remain classic. Chat has its own standard keyboard paths and authorized slash commands, not those bindings. |

## M5 §2.7 functionality retained in classic

| ID / feature | Classic location | Chat location | Status | Evidence | Notes |
|---|---|---|---|---|---|
| D01 · Rule revocation | Approvals → remembered rules (`app.js:1393,2087`) | More → Classic dashboard → Approvals → Revoke | Linked to classic | L1; classic remembered-rules/audit test | Native remember-on-approve is preserved; revocation stays classic. |
| D02 · Paid models and spend controls | New run → Models; Runs → cap raise/local fallback; Usage | Settings → classic dashboard; More → Usage | Linked to classic | L2, L1; classic paid tests | Typed consent and backend spend enforcement unchanged. |
| D03 · Stuck watch | New run → Stuck watch; Mission resource Turn off (`app.js:1031,2027`) | Settings → classic dashboard | Linked to classic | L2; classic “stuck watch: offered only with a key, needs approve, advisory mark, turn off, Activity wording” | No chat opt-in/off control; watch alerts may be projected publicly. |
| D04 · Internet during work | New run → isolation/network typed consent | Settings → Advanced → classic dashboard | Linked to classic | L2; classic isolation/network tests | Chat authorizes only setup or none. No broadened network mode or consent. |
| D05 · Skill removal / rollback | Runs → skill panel Remove (`app.js:1268,2059`) | More → Skills → classic Runs → Remove | Linked to classic | L1; classic skills-panel test | README defines rollback as Remove (`agent-autonomy/README.md:472`); no extra rollback action exists. |
| D06 · Propose a library skill | Runs → skill panel Add (`app.js:1275,2053`) | More → Skills → classic Runs → Add | Linked to classic | L1; classic skills-panel test | Room only decides server-projected proposals. |
| D07 · Propose a git skill source | Runs → Add from git (`app.js:1277,2054`) | More → Skills → classic Runs → Add from git | Linked to classic | L1; classic skills-panel test | Pinned URL/ref/path proposal stays classic; native fetch approval does not create proposals. |
| D08 · Preview lifecycle/configuration controls | Project Start/Restart/Stop/Save (`app.js:2107–2119`) | More → Classic dashboard → Project; Open in classic pop-out | Linked to classic | L1, P2; classic preview controls tests | Native Settings configures new-session previews only; editing/restarting an existing preview remains classic. |
| D09 · Container lifecycle/resource controls | Runs → container (`app.js:1872–1888,2084`) | More → Classic dashboard → Runs | Linked to classic | L1; classic container controls tests | Includes Start/Stop and availability refresh; launch settings alone do not port the panel. |
| D10 · VM lifecycle controls | Runs → VM (`app.js:1891–1908`) | More → Classic dashboard → Runs | Linked to classic | L1; classic VM controls tests | VM screen/input separately listed below. |

## Interactive surfaces — each retained in the classic pop-out

| ID / feature | Classic location | Chat location | Status | Evidence | Notes |
|---|---|---|---|---|---|
| S01 · Web/static preview frame and one-time ticket | Project/Workspace (`workspace.js:617,625`; `app.js:1553–1564`) | Open in classic pop-out | Linked to classic | P2; classic W6 web-frame/ticket test | No native iframe, ticket issuance or preview-origin key handling added. |
| S02 · Program terminal and typed input | Project/Workspace (`workspace.js:618,776`; `index.html:149–152`) | Open in classic pop-out | Linked to classic | P2; classic CLI/W6 program tests | Read-only agent transcript is different from interactive program input. |
| S03 · VM screen/frame and console input | Project/Workspace (`app.js:1911–1926`) | Open in classic pop-out | Linked to classic | P2; classic VM Project screen/input test | No native VM mouse, text or key input. |
| S04 · Desktop frame and mouse/text/key input | Project/Workspace (`workspace.js:619–620,777`) | Open in classic pop-out | Linked to classic | P2; classic desktop coordinate/W6 tests | No native desktop input. |
| S05 · Generic/provider surface frames and input | Workspace (`workspace.js:642–660,780,807+`) | Open in classic pop-out | Linked to classic | P2; classic W6 generic-provider routes test | Includes browser-session/VNC surfaces; backend generic adapters unchanged. |
| S06 · Surface picker/expand and special key controls | Workspace (`workspace.js:607–620,637–639,670–685,733–735`) | Open in classic pop-out | Linked to classic | P1, P2; classic W6 tests | Chat lists accessible surface metadata and a link only. G2 choice (a) is already recorded by owner. |

## Further classic-only functionality (source/action inventory)

| ID / feature | Classic location | Chat location | Status | Evidence | Notes |
|---|---|---|---|---|---|
| C01 · Full decision history and hash-chain audit browser | Approvals (`index.html:136`) | More → Classic dashboard → Approvals | Linked to classic | L1; classic remembered-rules/audit test | Native receipts and backend auditing exist; full audit inspection is classic. |
| C02 · Required review too large/unsupported for room | Full classic review dialogs | Room card → Open in classic dashboard | Linked to classic | T11, T12 | Room blocks approval when required evidence is truncated/unsafe; safe refusal remains. Classic review is not assumed to override server validation. |
| C03 · All-project run history and run search | Recent runs All projects / filter (`index.html:72`) | More → Classic dashboard → Runs | Linked to classic | L1; classic filter/project tests | Chat remains current-project scoped; no changed history sources or counts. |
| C04 · Full raw Activity and search/filter | Activity (`index.html:137`) | More → Activity → Activity | Linked to classic | L1; classic help/filter test | Includes recorded Hermes requests and omitted/folded journal events. Private reasoning is never rendered; chat Workspace log excludes request prompts. |
| C05 · Recorded diff download | Diff dialog Download (`index.html:273`; `app.js:2014`) | More → Classic dashboard → Runs → Changes | Linked to classic | L1; classic diff/escaping test | Native selected-turn escaped diff is N11; chat offers no download button. |
| C06 · Workspace tabs, split panes and movable/resizable windows | Workspace (`index.html:90`; `workspace.js:176,181`) | More → Classic dashboard → Workspace | Linked to classic | L1, P1; classic W4/W5 layout tests | Includes minimize/maximize, dock, changed/unread indicators, agent-filter navigation and split resize. Native chat opens one inspection pane. |
| C07 · Standalone pop-out relaying across classic windows | Workspace Pop out / BroadcastChannel (`workspace.js:330–340`) | Open in classic pop-out | Linked to classic | P1; classic W5 relay/pop-out test | Classic multi-window relaying is not a chat implementation. Pathname behavior confirmed in readiness audit. |
| C08 · Full agent state-history view | Workspace lifecycle timeline | Open in classic pop-out | Linked to classic | P1; classic lifecycle/state-history test | Chat shows recorded current state/since and bounded room progress; it does not reproduce the full state history. |
| C09 · Detailed model queue, slots, per-agent token/spend tables | Mission resources; Runs model usage; Usage (`app.js:928,1018`) | More → Usage / Classic dashboard | Linked to classic | L1; classic model-server/Mission/Usage tests | Connections health is a native subset, not queue/cost parity. |
| C10 · Remaining time/turn budget and detailed run summaries | Mission/Run header (`app.js:591–606`) | More → Classic dashboard → Mission / Runs | Linked to classic | L1; classic “file and budget summaries use recorded values without invented counts” | Native limit settings remain available, but remaining-budget dashboard displays are classic. |
| C11 · Saved goal-check list and evidence panel | Runs → goal checks (`app.js:813–825`) | More → Classic dashboard → Runs | Linked to classic | L1; classic goal-check/audit copy tests | Chat supports checks in Settings and `/check`, plus recorded notes; full checklist/evidence presentation remains classic. |
| C12 · Ask for a status draft template | Runs → steering tools (`app.js:2052`) | More → Classic dashboard → Runs | Linked to classic | L1 | Chat supports ordinary notes, but has no named Ask for a status template. |
| C13 · Browser notification opt-in/out | Connections → Notifications (`app.js:2102`) | More → Classic dashboard → Connections | Linked to classic | L1 | Backend notifications remain unchanged; no chat browser-notification control. |
| C14 · Explicit Forget key / sign out control | Connections → Forget key (`app.js:2103`) | More → Classic dashboard → Connections | Linked to classic | L1; classic sign-in/storage tests | Shared key semantics and chat 401 clearing remain native; chat has no explicit sign-out button. |
| C15 · Project folder browsing and creation | Project switch dialog (`index.html:271`) | More → Switch project → classic project name | Linked to classic | L1; classic project tests | Switch, browse and create are classic; no chat project POST added. |
| C16 · Terminal Copy and full-screen toggle | Runs Code → Copy / `t` (`app.js:2106,2121`) | Open in classic pop-out; classic Runs → Code for `t` | Linked to classic | P1, L1; classic terminal tests | Native readonly terminal has follow/pause/Jump and keyboard scrolling, without Copy or `t`. |
| C17 · Verify while paused/interrupted/attention and full on-demand command/output panel | Runs → Verify now (`app.js:829–843`) | More → Classic dashboard → Runs | Linked to classic | L1; unchanged backend on-demand verification tests | M5 chat Verify acts only on a server-actionable outcome. Native outcome status/time is R05; full manual verifier command/output panel remains classic. |
| C18 · Built-in example brief and full classic help/onboarding | New run → Try Python brief; Help dialog (`index.html:189,275–286`) | More → Classic dashboard → New run / Help | Linked to classic | L1; classic help/shortcuts tests | Chat has empty-room guidance and `/help` command help, but not the named classic sample-brief template or full classic tutorial. |

## Native subsets of the composite classic views above

| ID / feature | Classic location | Chat location | Status | Evidence | Notes |
|---|---|---|---|---|---|
| N01 · Live read-only agent terminal | Runs/Workspace Code terminal | `#/w/...` → Terminal / Jump to latest | Native | T13 + W5 / IMG01 | Follows live output until user scrolls up; arrow/Page/Home/End navigation. Full screen/Copy remain C16. |
| N02 · Read-only agent Workspace inspection | Workspace | `#/w/<run>/<agent>` from recorded turn/member/task | Native | T14, T15 + W5 / IMG01 | Turns, stages, prompt disclosure, captured diff/verification and bounded recorded logs. Active snapshot adds no read; historical uses shared M6 read; no Workspace decisions/input. |
| N03 · Session start and Reply in session follow-up | New run / follow-up | Composer; room outcome → Reply in session | Native | T16, T17 + W1 / W8 | Uses existing runs endpoint and recorded parent/settings. Goal is not echoed as a local message. |
| N04 · Notes, targeting and approved control aliases | Runs steering / Pause/Resume/Stop/check/title | Composer leading `@agent`, authorized slash commands, session menu | Native | T18, T19 + IMG08 / keyboard matrix | Only a leading valid agent token targets a note. Pause/resume/stop retain confirmation/error behavior. Decision aliases share M5 cards/write lock; no new command types. |
| N05 · Authorized Basic/Advanced start Settings | New run subset | Composer → Settings | Native | T20, T21 + W1 / IMG09 | Title/verifier/checks/mode/limits/isolation/setup/preview; dirty acknowledgement. Paid/watch/internet are explicit L2 fallbacks. Existing per-session versus remembered preference rules retained. |
| N06 · Project room history, session rail and paging | Recent runs / Runs | `#/`, `#/s/<run>` → Load earlier / Load earlier sessions | Native | T22, T23 + IMG10 | Server-projected history, union rail and shared paging. N1 hides X ≥ N disclosure; backend counts unchanged. Cross-project filters remain C03. |
| N07 · Recorded members, proposed team and vertical task graph | Mission / Runs team panel | Selected session → Team/Members; task → latest recorded turn | Native | T07, T24 + W4 / IMG04 | Separates proposed from actual joined agents. Stopping/finished proposals have no decision controls; panel itself has no team decisions. |
| N08 · Connections health and Check connections | Connections | Rail → Connections / Check connections | Native | T25 + IMG11 | Uses recorded per-service health and existing `/api/check`, under shared write lock. Detailed model queue/usage remains C09. |
| N09 · Server-projected skill fetch/install/reject decisions | Approvals skill proposals | Room skill card | Native | T26, T27 + IMG12 | Exact existing endpoints; only accepted awaiting-fetch Reject exception. Expanded install evidence; truncation restrictions hold. Propose/remove/library remain D05–D07. |
| N10 · Available surface metadata | Workspace surface selector | `#/w/...` → Available surfaces | Native | T28 + IMG13 | Recorded title/kind/state/note filtered for agent. Live frame/ticket/input are all linked surfaces S01–S06. |
| N11 · Captured changed files, diff and per-turn verification results | Runs / Workspace changes and Verify | `#/w/...` → Changed files / Diff / Verification | Native | T29, T30 + IMG14; W6 for outcome status | At most 50 file rows, honest partial/truncated labels, escaped recorded text. Outcome on-demand status/time is server-projected; full manual-verifier command/output panel stays C17. |

## Evidence directory and exact passing test names

DOM names below are in `agent-autonomy/tests/test_chat_ui.cjs` and passed freshly at Part 0's gate
(`/tmp/ac-m9-0-chat-approved.log`, 240/240). Part A repeats the unchanged suites; its final results are recorded
below and in the handoff report. Real-server requests/results are in `/tmp/ac-m9-real-results.json` and
`/tmp/ac-m9-real-check.log`; the temporary harnesses are `/tmp/ac-m9-real-server.py` and
`/tmp/ac-m9-real-check.cjs`, outside the repository. These artifacts contain test-only data, not the dashboard key.
Screenshot files referenced here are actual renders, not design mockups. `/tmp` evidence is local and ephemeral;
the durable findings, request shapes/counts and suite results are transcribed into this checklist and the report.

| Code | Exact passing chat test name |
|---|---|
| T01 | `M7 C every stage-state combination matches a table evaluated from classic` |
| T02 | `M5 DOM exact critical approve {"confirm":"CONFIRM-TEST"}` |
| T03 | `M5 DOM exact question answer {"answers":["JSON"]}` |
| T04 | `M5 DOM exact outcome apply {}` |
| T05 | `M6 a recorded verification revision reconciles Sent without a false timeout` |
| T06 | `M5 DOM exact proposal approve_team {}` |
| T07 | `M6 proposed agents never become live members and the panel has no decisions` |
| T08 | `M4 Auto previews before sending and preview shapes match classic` |
| T09 | `M5 DOM exact research approve {"confirm":"CONFIRM-TEST"}` |
| T10 | `M7 D researcher log has question, status, bounded summary and eight plain sources` |
| T11 | `M5 truncation blocks approvals but keeps safe refusal choices` |
| T12 | `M5 unsupported or unavailable review material cannot be approved` |
| T13 | `M7 C latest follows output, scroll-up holds position and Jump resumes without a read` |
| T14 | `M7 B Workspace route selects its session and recorded agent without an extra active read` |
| T15 | `M7 B historical Workspace and members share exactly one guarded GET per selection` |
| T16 | `M4 new session sends only goal and remembered/changed settings` |
| T17 | `M4 all finished outcomes offer follow-up and inherit exact parent fields` |
| T18 | `M4 Hermes and leading @agent routing use exact bodies and preserve later tokens` |
| T19 | `M4 pause, resume and chip are exact aliases; menu errors stay inline` |
| T20 | `M4 Basic/Advanced Settings and unavailability reasons disclose progressively` |
| T21 | `M4 available isolation and all changed Basic/Advanced values send their exact shapes` |
| T22 | `M6 rail paging grows the shared room cache and reports exact X/N counts` |
| T23 | `M9 N1 cached sessions exceeding the server total do not show an incomplete-history disclosure` |
| T24 | `M6 member details and vertical tasks show statuses, attempts, reasons and labels` |
| T25 | `M6 Connections display per-service symbols, labels and exact shared-lock check` |
| T26 | `M5 DOM exact skillInstall approve {}` |
| T27 | `M5 only awaiting-fetch skill Reject can use the authorized endpoint exception` |
| T28 | `M7 D surfaces have metadata and one section pop-out, with no native controls or frames` |
| T29 | `M7 D file omission and path keys survive updated evidence and preserve focused row` |
| T30 | `M7 D selected turn shows files, partial counts, diff truncation and failed verification` |

Link-test evidence:

| Code | Passing test and exact behavior |
|---|---|
| L1 | Temporary real-server `M9-L1 exact More destinations remain /classic`: asserts all six label/href pairs: Skills, Usage, Activity, Settings, Switch project, Classic dashboard → `/classic`. Existing DOM `M6 keyed updates preserve every More link and focus the latest recorded task turn` checks that labels/focus survive keyed updates. |
| L2 | Temporary real-server `M9-L2 Settings fallback links remain /classic`: both Settings fallback anchors have href `/classic`; the UI identifies paid models/stuck watch and internet-during-work. |
| P1 | `M7 B header uses recorded researcher, role, task, since and exact classic pop-out link`: exact encoded root pop-out href, `_blank`, `noopener noreferrer`; no POST. |
| P2 | `M7 D surfaces have metadata and one section pop-out, with no native controls or frames`: exact pop-out href and no native iframe/input, surface reads, ticket request or POST. |
| E1 | Temporary real-server `M9-E1 Auto shows the real-server mode explanation`: existing `/api/mode/preview` returns the visible explanation; screenshot `/tmp/ac-m9-auto-preview.png`. No session was started by this extra check. |

C02's fallback link is explicitly tested by T11/T12: a truncated/unsupported required review prevents approval
and retains the `/classic` link plus safe refusal. Every Linked row cites a test of its actual link. Generic
links still require selecting the classic destination; no nonexistent deep link is implied.

### Actual rendered evidence

| Code | Screenshot or recorded real-server step |
|---|---|
| IMG01 | `/tmp/ac-m9-live-workspace-desktop.png`, `/tmp/ac-m9-live-workspace-phone.png`; W5 |
| IMG02 | `/tmp/ac-m9-critical-dialog.png`; W2 and W3 receipts |
| IMG03 | `/tmp/ac-m9-apply-dialog.png`, `/tmp/ac-m9-step-6.png`, `/tmp/ac-m9-step-8.png`; W6–W8 |
| IMG04 | `/tmp/ac-m9-proposed-team.png`, `/tmp/ac-m9-step-4.png`; W4 |
| IMG05 | `/tmp/ac-m9-auto-preview.png`; E1 |
| IMG06 | `/tmp/chat-shots-m9-0/workspaceReviewer-desktop-light.png` |
| IMG07 | `/tmp/chat-shots-m9-0/workspaceResearcher-desktop-light.png`, `decisionResearch-phone-light.png` in the same directory |
| IMG08 | `/tmp/chat-shots-m9-0/composerNote-desktop-light.png`; keyboard matrix start/note cases |
| IMG09 | `/tmp/chat-shots-m9-0/composerBasic-desktop-light.png`, `composerAdvanced-desktop-light.png` |
| IMG10 | `/tmp/chat-shots-m9-0/railPaged-desktop-light.png`; full paging DOM regressions |
| IMG11 | `/tmp/chat-shots-m9-0/connections-desktop-light.png` |
| IMG12 | `/tmp/chat-shots-m9-0/decisionInstall-phone-light.png` |
| IMG13 | `/tmp/chat-shots-m9-0/workspaceSurfaces-desktop-light.png` |
| IMG14 | `/tmp/chat-shots-m9-0/workspaceHistorical-desktop-light.png` |

The portrait-phone render is a Chromium viewport check. It does **not** verify a native iOS/Android keyboard or
VoiceOver/TalkBack. `docs/DEVICE_CHECKLIST.md` still has blank results; only the owner can clear G3.

## Chat-only real-server walkthrough

Real `app.py` handler and `Controller`, existing `FakeTeamAPI`, `FakeTeamManager`, `coding`, `complete`,
`proposal` and `make_repo` test fakes, one disposable git repository, one server, one browser page.
Execution and fixtures use real worktrees, journal decisions, verification and Apply; no room responses are
mocked. The fake permission describes `rm -rf generated-build/` solely to exercise R3 classification; that
command is never executed. The saved verifier is `python3 -c "print(123)"`.

To follow the required order, W1–W3 use a single-agent session S1. W4 finishes S1 with the existing fake,
then creates a team session S2 through chat Settings/composer and approves its real proposal. W5–W7 use S2;
W8 creates follow-up S3 from S2. All three sessions are UI-created; no direct journal seeding is used.
The fake injects held OpenCode requests and later live transcript parts through its existing API, then releases
work normally. Fakes are the substitute for external agent runtimes, not for AgentControl's decisions.

After authenticated live boot, the harness stops the browser's recurring timers/SSE for deterministic step
measurement and invokes the **existing** `AC.core.refresh()` cycle when the fake's new record is ready.
No product refresh behavior or request path changes. Real HTTP handler counts are compared with instrumented
browser fetches for every API request. GET totals include browser `/favicon.ico`; the API subset is shown
separately. Initial page/assets/SSE boot is outside the eight steps. E1 is a separate Auto-preview evidence check
before W1, also outside those step totals.

For every checkpoint, the complete project thread has `before=null` and:
`waiting = actionable non-outcome messages`; `decision cards = waiting + actionable outcomes`, with outcomes ≤ 1.
The harness checks before and after each step, plus the waiting question and proposed-team intermediate states.
The existing newest-terminal outcome may coexist with an active session; it is preserved and counted separately.

| Step | Operation/result | GET total (API) | POST | Pending → recorded invariant `(waiting, non-outcome actions, outcomes, cards)` |
|---|---|---:|---:|---|
| W1 | Start S1 through composer/Settings; R3 permission recorded | 8 (8) | 1 | `(0, 0, 0, 0) → (1, 1, 0, 1)` |
| W2 | Blank typed confirm sends zero POST; displayed `approve` → confirmed receipt | 3 (3) | 1 | `(1, 1, 0, 1) → (0, 0, 0, 0)` |
| W3 | Choose JSON; confirmed answers `[["JSON"]]` from server | 6 (6) | 1 | `(1, 1, 0, 1) → (0, 0, 0, 0)` |
| W4 | Finish S1; start S2 in Team mode; approve proposal; coder-2 absent before approval, present after server records join | 21 (20) | 2 | `(1, 1, 1, 2) → (0, 0, 1, 1)` |
| W5 | Open coder Workspace with zero extra GET/POST; recorded terminal grows twice; inspect desktop and 390 px phone | 8 (6) | 0 | `(0, 0, 1, 1) → (0, 0, 1, 1)` |
| W6 | Finish S2; Verify now → recorded `detail.verification.status=passed` with recorded times; no manufactured browser success | 10 (10) | 1 | `(0, 0, 1, 1) → (0, 0, 1, 1)` |
| W7 | Confirm Apply with Cancel initially focused; server workspace becomes applied and API/UI/wire files exist in base checkout | 3 (3) | 1 | `(0, 0, 1, 1) → (0, 0, 1, 1)` |
| W8 | Reply in session → S3; journal `parent_run=S2`, inherited Team settings; S3 proposal still waiting | 8 (8) | 1 | `(0, 0, 1, 1) → (1, 1, 1, 2)` |

Eight-step totals: **67 GET** (**64 API GET**), **8 POST**.
E1: **2 GET / 1 POST**; returned explanation: “Auto would use one agent. 3 parts, but your model server answers one agent at a time and there is no verification command to run in parallel, so extra agents would mostly wait.”.
Boot: **19 GET / 0 POST**, including page/assets/events.
Only document load: `/chat`. **Zero classic page loads**, zero page errors.
W5 checks raw tool-output sentinel absent from room/members/rail, escaped output in Workspace with no injected
image/iframe, and private reasoning absent everywhere. The accepted M3 public turn `result_tail` projection stays
unchanged and may contain bounded assistant response text; it is not raw step rendering.

### Recorded GET request mix

The normal refresh is the established state/channels/thread read. `state` uses `scope=current` and its recorded
selected/active run, while thread uses `channel=main&limit=200` with known revision stubs after boot. Counts below
include existing targeted state reads where noted; all URLs and query strings are preserved in the JSON evidence.
No per-Workspace timer/read or new endpoint is involved.

| Step | GET API paths and counts |
|---|---|
| W1 | `/api/sandbox` × 1; `/api/workspace/preflight` × 1; `/api/state` × 2; `/api/channels` × 2; `/api/thread` × 2 |
| W2 | `/api/state` × 1; `/api/channels` × 1; `/api/thread` × 1 |
| W3 | `/api/state` × 2; `/api/channels` × 2; `/api/thread` × 2 |
| W4 | `/api/state` × 6; `/api/channels` × 6; `/api/thread` × 6; `/api/sandbox` × 1; `/api/workspace/preflight` × 1 |
| W5 | `/api/state` × 2; `/api/channels` × 2; `/api/thread` × 2 |
| W6 | `/api/state` × 4; `/api/channels` × 3; `/api/thread` × 3 |
| W7 | `/api/state` × 1; `/api/channels` × 1; `/api/thread` × 1 |
| W8 | `/api/state` × 3; `/api/workspace/preflight` × 1; `/api/channels` × 2; `/api/thread` × 2 |

W4 additionally has one `/favicon.ico` GET and W5 two. W6 includes the existing targeted state read for terminal
outcome reconciliation. W8 includes the existing parent settings read. These are actual measured counts, not
claims that every decision necessarily causes a fixed number of reads.

### Exact recorded POST shapes

Session ids are renamed S1/S2/S3 below; fingerprints are the displayed server values, not client-generated.
The local JSON artifact retains the actual body values. No endpoint or body was invented by this audit.

| Step | Existing endpoint | Recorded body |
|---|---|---|
| W1 | `/api/runs` | `{goal, verifier: 'python3 -c "print(123)"'}` |
| W2 | `/api/review` | `{run:S1, kind:'permission', request_id:'per-m9-critical', fingerprint:<displayed>, action:'approve', confirm:'approve'}` |
| W3 | `/api/review` | `{run:S1, kind:'question', request_id:'que-m9-storage', fingerprint:<displayed>, action:'answer', answers:[['JSON']]}` |
| W4 start | `/api/runs` | `{goal, verifier:'python3 -c "print(123)"', mode:'team', team_size:2}` |
| W4 approve | `/api/control` | `{run:S2, action:'approve_team'}` |
| W6 | `/api/control` | `{run:S2, action:'verify'}` |
| W7 | `/api/control` | `{run:S2, action:'apply'}` |
| W8 | `/api/runs` | `{goal, verifier:"python3 -c 'print(123)'", max_steps:8, mode:'team', team_size:2, parent_run:S2}` |

W2/W3 and W4 explicitly check journal-confirmed reviews/audit/team state. W6 checks the recorded outcome status/time;
W7 checks recorded workspace state plus actual base-checkout files. Apply merges only the disposable test
project's base branch; AgentControl's `main` is untouched. W8 checks the recorded parent relation.
No local receipt or waiting-count update is used as proof of success.

## Cutover-readiness findings — documentation only

Searched all `chat/*`, classic `index.html`, `app.js`, `workspace.js`, CSS, both READMEs and the tests for
root navigation, pop-out links, pathname usage, route assumptions and dashboard tutorials. The raw search
inventory is `/tmp/ac-m9-route-audit.txt`; relevant assumptions are listed individually below.
No routing, link or test expectation is changed in Part A.

| File:line | Assumption / finding | Later disposition under the handoff |
|---|---|---|
| `agent-autonomy/app.py:74` | Current `do_GET` serves classic for both `/` and `/classic`; chat entries are at `:76–77`. | Part B alone may swap those entry routes. Unchanged in this audit. |
| `agent-autonomy/chat/workspace.js:5` | Pop-out helper builds `/?popout=…&run=…`; header at `:23` and surface section at `:101` share it. After `/` becomes chat, it would open chat rather than standalone classic. | Part B's authorized href becomes `/classic?popout=…&run=…`, encoded exactly as now. |
| `agent-autonomy/workspace.js:337` | Classic builds `${location.pathname || '/'}?popout=…&run=…`. | Confirmed by inspection: at `/classic`, its own pop-out stays `/classic`. No classic-code correction needed. |
| `agent-autonomy/tests/test_chat_ui.cjs:1049` | Researcher-header exact root pop-out assertion. | Named future Part B assertion update; unchanged now. |
| `agent-autonomy/tests/test_chat_ui.cjs:1185` | Coder-surface exact root pop-out assertion. | Named future Part B assertion update; unchanged now. |
| `agent-autonomy/tests/test_chat_routes.py:33` | `/` is read as classic, then `/classic` is asserted byte-equal at `:35–36`. | Authorized Part B entry-route expectations; all other Python tests unchanged. |
| `agent-autonomy/tests/test_ui.cjs:28` | Classic DOM harness pathname is `/`. | Isolated classic harness remains unchanged. |
| `agent-autonomy/tests/test_ui.cjs:1303` | Root pop-out expectation follows that classic harness pathname. | Correct for its mock; classic suite remains unchanged. |
| `agent-autonomy/tests/screenshots.cjs:276` | Classic mock static server maps `/` to classic `index.html`. | Independent classic screenshot harness, not real-server routing; remains classic. |
| `agent-autonomy/tests/screenshots.cjs:282` | Classic rendered suite navigates `http://agentcontrol.test/` (pop-out scenario also appends its query). | Same independent classic mock. |
| `README.md:24` | Printed root dashboard URL introduces the classic-described experience. | Future Part B README describes chat at `/`, classic at `/classic`. |
| `README.md:35` | “What you see” bullets through `:79` describe classic layouts, terminal shortcut, preview and themes without the new route distinction. | Future Part B docs explain native versus linked capabilities; current README unchanged. |
| `agent-autonomy/README.md:12` | Dashboard introduction through `:20` describes classic turns/layout/themes. | Future Part B docs distinguish default chat and classic. |
| `agent-autonomy/README.md:44` | Root address followed by classic Connections/Forget key/New run tutorial at `:47–51`. | Future Part B docs identify the proper route for those classic steps. |
| `agent-autonomy/README.md:90` | Project-name/sidebar browse-create-switch instructions imply the root dashboard supports classic controls. | Future Part B docs label this classic fallback; chat More → Switch project reaches it. |
| `agent-autonomy/README.md:119` | “Mission is the dashboard's home,” plus phone bottom tabs at `:132`, describe classic without a route qualifier. | Future Part B docs qualify classic; these are not chat-native views. |


The same README also gives classic-view instructions without an entry-route qualifier. These are documentation
assumptions rather than additional broken product links; later docs should label them as classic while retaining
shared backend descriptions:

| File:line | Classic-specific instruction |
|---|---|
| `agent-autonomy/README.md:136` | Workspace is a tab beside Mission, with remembered agent tabs. |
| `agent-autonomy/README.md:155` | Classic Workspace `1–9`, `[`, `]` keyboard bindings. |
| `agent-autonomy/README.md:165` | Split layout and pane focus/resize controls. |
| `agent-autonomy/README.md:172` | Native classic surface frames, picker, Expand and input. |
| `agent-autonomy/README.md:190` | Windows layout, minimization, focus/dock and theme styling. |
| `agent-autonomy/README.md:203` | Classic multi-window pop-out relaying and tab indicators. |
| `agent-autonomy/README.md:224` | Separate Approvals inbox / classic review dialog instructions. |
| `agent-autonomy/README.md:365` | Theme picker and classic keyboard controls. |
| `agent-autonomy/README.md:455` | Skills tab library and classic run-page git-source proposal; Remove/history at `:472`. |
| `agent-autonomy/README.md:642` | Model usage panel on the classic run page. |
| `agent-autonomy/README.md:711` | New run Models selection and paid typed consent. |
| `agent-autonomy/README.md:717` | Run-page cap raise/local fallback controls. |
| `agent-autonomy/README.md:720` | Usage sidebar reports and period selection. |
| `agent-autonomy/README.md:732` | New run Stuck watch opt-in and Mission Resources Turn off. |
| `agent-autonomy/README.md:768` | Project tab auto-open, embedded preview and interactive controls. |
| `agent-autonomy/README.md:791` | Named Start follow-up run control; chat instead uses Reply in session. |

No other chat root-page navigation assumes classic. Existing `/classic` dashboard links are already correct
for the planned swap. Hash routes and root-relative **assets** are intentional: classic assets remain at their
existing root paths; chat assets remain under `/chat/`. Root-relative API/SSE URLs and separate preview-origin
`/__ac/enter` ticket URLs (`app.js:1560–1563,2113`) are not dashboard-route assumptions and must remain unchanged.
The app.py route swap, `/classic/` behavior, any href updates and README edits are all Part B, outside this task.

## Owner gates and remaining limitations

- **G1 pending:** owner accepts this 72-row checklist, including all 54 Linked rows and zero Missing rows, as
  sufficient for cutover. Zero Missing means reachable functionality, not full native parity.
- **G2 choice (a) already recorded by owner:** interactive surfaces remain in the standalone classic pop-out
  through cutover. Native surfaces require their own later handoff.
- **G3 pending:** physical iOS Safari and Android Chrome checks in `docs/DEVICE_CHECKLIST.md` remain blank.
  Native keyboards, rotation with those keyboards and VoiceOver/TalkBack have not been verified by emulation.
- Classic stays supported. Retirement and any merge into `main` require separate owner decisions.
- The intentionally excluded in-flight skill-fetch race remains outside D7. Persistent bots remain roadmap R1.
- No feature is added or corrected in Part A. Any owner-refused parity/device gate needs the architect's
  corrective handoff before Part B.

## Final Part A verification — 2026-10-02

Part 0 was completed, verified, committed and pushed as `568534e` before Part A began. Part A changes only
this checklist, `docs/handoffs/M9_PARITY_AND_CUTOVER.md` and `CURRENT_STATE.md`. No product or test file changed.

| Verification | Fresh result | Evidence |
|---|---|---|
| Full Python | **423 tests, OK (skipped=3), 319.958 s** | `/tmp/ac-m9-a-python.log` |
| Classic DOM | **82/82** | `/tmp/ac-m9-a-classic.log` |
| Chat DOM | **240/240** | `/tmp/ac-m9-a-chat.log` |
| Full browser matrix | **672 combinations + 51 regressions**, **1,139 screenshots** | `/tmp/ac-m9-a-browser.log`, `/tmp/chat-shots-m9-a/` |
| Real-server chat walkthrough | **8/8 steps**, **0 classic document loads**, **0 page errors** | `/tmp/ac-m9-real-check.log`, `/tmp/ac-m9-real-results.json` |
| Auto/link evidence | **E1, L1 and L2 passed** | Same real-server log / JSON |
| Checklist consistency | **72 classified rows**, all 15 README and 12 view rows; exact tests and existing renders checked | Temporary read-only consistency check; tables above |

Browser measurements retain **57 px idle / 105 px waiting** footers at 390 × 844 and 844 × 390, conversation
minimum **70.0829% portrait / 58.3333% landscape**. The matrix reports 1,624 accessibility audits with zero
findings, all 52 contrast pairs passing, 32 keyboard workflows and four reduced-motion/forced-colors cases
passing. These remain emulated browser checks, not G3 physical-device results.

Actual inspected renders include the real critical-confirm dialog, Auto explanation, proposed versus recorded
team, live Workspace at desktop and 390 px phone, and Apply; plus fresh matrix critical-phone,
historical-diff/failed-verification and researcher-log renders. Their paths are in the evidence directory above
and the appended completion report.

Part A's full Python run passed on its first attempt, run without other suites alongside it. Part 0's earlier
lifecycle sampling and VM-log races, isolated retries and final passing full run are recorded exactly in its
separate completion report; they match the established M7/M8 backend flakiness. No backend robustness fix or
weakened test was introduced.
The unchanged skips are `test_container_e2e.ContainerRunE2E.test_agent_works_in_a_locked_down_container`,
`test_preview.DesktopTests.test_desktop_preview_shows_frames_and_accepts_input`, and
`test_vm_e2e.VMRunE2E.test_agent_works_in_a_kvm_clone`. The OpenCode trio ran and passed.

**Stop point:** M9 Part A complete; awaiting owner gates G1–G3 (G2 choice (a) already recorded). No Part B,
route cutover, native surfaces, classic retirement, backend change or merge into `main` was performed.
