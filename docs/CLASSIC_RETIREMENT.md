# Classic retirement: triage and plan

**Status:** the triage and its order are **approved by the owner on 2026-10-04 ("approve classic cleanup")** and recorded as
**D21** in `docs/REDESIGN_ARCHITECTURE.md`. Retirement starts **after N2**. **The final removal (CR5) needs its own
explicit owner approval when it is reached,** because it cannot be undone in practice. Until CR5, classic keeps working
at `/classic`, and its 82 tests stay required (acceptance §A1).

The source is the 54 "Linked to classic" rows of `docs/PARITY_CHECKLIST.md`. Each row below is assigned exactly one outcome.

| Outcome | Rows | Meaning |
|---|---:|---|
| **A. Already native** | 3 | The chat has had it since N1. Its classic link is removed in CR1 |
| **B. Drop** | 14 | Not needed in the redesign. It goes away with classic in CR5. Recorded as removed on purpose, not lost |
| **C. N series** | 5 | Made native by N2 (assignment) and N5 (session installs). No separate port |
| **D. Port** | 32 | Needed. Made native in CR1–CR4 before classic is removed |

**Correction made while writing this triage.** The proposal shown to the owner put remembered-approval revocation, the
decision history and the full audit (D01, V04, C01) under "already in the N series". No N milestone plans them, so they are
**Port** (CR1). They are kept either way; only where the work happens changes.

## The 54 rows

| Row | Classic-only feature | Outcome | Where it goes |
|---|---|---|---|
| C14 | Explicit Forget key / sign out | **A** | Native since N1: Settings › Sign-in |
| C15 | Project folder browsing and creation | **A** | Native since N1 and N1.2: Projects "+" (Create project, Open folder…) |
| V11 | Switch project | **A** | Native since N1: Projects list |
| R12 | Mission control | **B** | Superseded by Projects (team thread) and Session details |
| V01 | Mission view | **B** | As R12 |
| V02 | Classic Workspace view (tabs) | **B** | Superseded by Turn details; files arrive in N6 |
| V03 | Runs view | **B** | Superseded by sessions in the team thread (all-project history is C03, Port) |
| V10 | Classic Settings (distributed) | **B** | Superseded by the chat's Settings section |
| V12 | Classic keyboard shortcuts | **B** | Classic-specific |
| C06 | Workspace tabs, split panes, movable/resizable windows | **B** | Not part of the chat design |
| C07 | Standalone pop-out relaying across classic windows | **B** | Classic window system; native surfaces (CR4) replace pop-outs |
| R02 | Live terminal full screen (`t`) | **B** | The live transcript stays native in Turn details; only full screen is dropped |
| C16 | Terminal Copy and full-screen toggle | **B** | As R02 |
| C18 | Built-in example brief and classic help/onboarding | **B** | The chat's empty states replace it |
| C12 | "Ask for a status" draft template | **B** | Notes and `@agent` cover it |
| C13 | Browser notification opt-in/out | **B** | Dropped (the owner can ask for it back as its own feature) |
| C05 | Recorded diff download | **B** | Diffs stay visible in Turn details |
| R08 | Skills, including library and removal | **C** | N2 (catalogue and assignment), N5 (install per session through the existing trust path) |
| V08 | Skills view | **C** | As R08 |
| D05 | Skill removal / rollback | **C** | As R08: unassigning removes it from future sessions; an in-session removal path is checked in N5 |
| D06 | Propose a library skill | **C** | As R08 |
| D07 | Propose a git skill source | **C** | As R08: the git source becomes part of catalogue management in N2's follow-up |
| D01 | Remembered-approval revocation | **D** | CR1 |
| V04 | Approvals view (rules and history) | **D** | CR1 |
| C01 | Full decision history and hash-chain audit browser | **D** | CR1 |
| C02 | Review too large or unsupported for the room | **D** | CR1: a native full-review view, so no card needs classic |
| V06 | Full New run dialog | **D** | CR2: everything in the composer's Settings |
| R09 | Virtual machines | **D** | CR2 |
| R13 | Containers | **D** | CR2 |
| D04 | Internet during work | **D** | CR2 (typed confirmation unchanged) |
| D09 | Container lifecycle/resource controls | **D** | CR2 |
| D10 | VM lifecycle controls | **D** | CR2 |
| R11 | Optional paid models | **D** | CR2 (typed confirmation and caps unchanged) |
| D02 | Paid models and spend controls | **D** | CR2 |
| D03 | Stuck watch | **D** | CR2 (typed confirmation unchanged) |
| R14 | Model server | **D** | CR3 |
| V05 | Activity view | **D** | CR3 |
| V09 | Usage view | **D** | CR3 |
| C03 | All-project run history and run search | **D** | CR3 |
| C04 | Full raw Activity and search/filter | **D** | CR3 |
| C08 | Full agent state-history view | **D** | CR3 |
| C09 | Detailed model queue, slots, per-agent token/spend tables | **D** | CR3 |
| C10 | Remaining time/turn budget and detailed run summaries | **D** | CR3 |
| C11 | Saved goal-check list and evidence panel | **D** | CR3 |
| C17 | Verify while paused/attention, and the full command/output panel | **D** | CR3 |
| R04 | Project tab / live preview | **D** | CR4 |
| V07 | Project view | **D** | CR4 |
| D08 | Preview lifecycle/configuration controls | **D** | CR4 |
| S01 | Web/static preview frame and one-time ticket | **D** | CR4 |
| S02 | Program terminal and typed input | **D** | CR4 |
| S03 | VM screen/frame and console input | **D** | CR4 |
| S04 | Desktop frame and mouse/text/key input | **D** | CR4 |
| S05 | Generic/provider surface frames and input | **D** | CR4 |
| S06 | Surface picker/expand and special key controls | **D** | CR4 |

## The retirement series (bounded; each step needs its own handoff and review)

| Step | Scope | Notes |
|---|---|---|
| **CR1 Approvals and audit** | D01, V04, C01, C02. Also remove the classic links of the three A rows | Approval semantics unchanged; the native full review must show everything the classic dialog shows |
| **CR2 Run options and controls** | V06, R09, R13, D04, D09, D10, R11, D02, D03 | Every typed confirmation, spend cap and resource limit unchanged |
| **CR3 Visibility** | R14, V05, V09, C03, C04, C08, C09, C10, C11, C17 | Read-only views over existing endpoints |
| **CR4 Native surfaces** | R04, V07, D08, S01–S06 | Needs its **own security review**: the preview stays a separate origin with one-time tickets; every input is audited without the typed text. Replaces the `/classic?popout=` links |
| **CR5 Removal** | Delete the six classic files (`index.html`, `app.js`, `workspace.js`, `app.css`, `workspace.css`, `themes.css`), the `/classic` route and C1 root pop-out compatibility (a redirect into the chat, or a 404: the owner chooses at the time), the classic tests (`test_ui.cjs`, `screenshots.cjs`), every chat link to classic, and the B features. Audit backend endpoints used only by classic and remove them only with the owner's approval | **Separate explicit owner approval at the time.** Back up first; announce the URL change |

**Recommended interleaving with the N series** (adjustable by the owner): N2 → CR1 → CR2 → N3 → CR3 → N4 → N5 → CR4 (with
N6, since both concern the workspace and surfaces) → CR5.
