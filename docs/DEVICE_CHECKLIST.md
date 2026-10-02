# Owner physical-device checks for M9 G3 — round 2 after M9.1

M9.1 Chromium regressions verify layout, including a simulated visual viewport. They do **not** verify native
OS keyboards, pinch zoom, VoiceOver or TalkBack. G1 is cleared and G2 choice (a) is recorded; **G3 stays pending**
until the owner records these physical-device results. M9 Part B route cutover remains unauthorised.

## Before you start

Use a real iPhone with Safari and a real Android phone with Chrome. Record model, OS, browser and screen-reader
versions. Repeat the checks below in **Light and Dark**, on both devices. Keep the keyboard open for the keyboard
and rotation steps; a closed-keyboard check does not cover them.

From `~/AgentControl` on `feature/chat-first-redesign`, run the isolated fixture:

```sh
python3 agent-autonomy/tests/device_fixture.py --host 192.168.1.50 --port 8767
```

Replace `192.168.1.50` with the computer's actual LAN or tailnet **IPv4 address**, reachable from the phone.
The host flag is an explicit bind; without it, the default `127.0.0.1` is reachable only on the computer:

```sh
python3 agent-autonomy/tests/device_fixture.py --port 8767
```

Open the **printed URL ending in `/chat`** on the phone. Paste the **fresh throwaway test key** printed by this
fixture into Connect. It is not the real dashboard key. Prefer a private browser tab for this separate test
origin. The script accepts no real project/state path: its real handler/controller use existing fakes, a
new temporary state directory and a disposable git repository. Ctrl+C shuts it down and removes that directory.
Restarting generates a new key and fresh requests; reconnect with the newly printed key.

Ready prerequisites are **one active session**, **one critical permission**, **one question**, a coder transcript
that gains output roughly every three seconds, and **turn 1 with a captured diff and passed verification**.
Initially both waiting indicators say **2 waiting for you**. The cleanup permission is simulated; its displayed
`rm -rf generated-build/` is never executed. Cancel confirmations during this checklist so the prerequisite stays.
If you answer/deny/approve a request to check announcements, use only this disposable fixture and restart it
before the next device/appearance run. It holds the live turn for up to two hours; restart if it expires.

Alternatively, on a project you control, start a normal session with a verifier, let one turn finish with changes
and verification, and leave the next coder turn running with a critical permission and a question awaiting your
review. Confirm both real requests exist and the waiting count is 2 before testing; use the fixture if you cannot
produce those prerequisites. No real-project changes are performed by the device-test tool.

## Where things are in the chat UI

- **Requests/approvals:** cards in the room, not a separate Approvals page. Tap the **2 waiting for you** bar above
  the message box, or open **☰ → Channels → 2 waiting for you**, to reveal a card. At zero the rail says
  **Nothing is waiting for you**. Classic retains remembered-rule revocation and full audit history.
- **Workspaces:** each turn has a visible **Open workspace** link outside Details; **☰ → Members → Open workspace**
  opens a recorded member; **⋯ → Workspaces** lists the active recorded members. Hermes uses **Open log**.
  Proposed-only agents have no member Workspace link. Back to room returns to the opening control.
- **Settings:** composer gear when starting a new session. During an active session the gear is hidden;
  finish/stop the disposable session using **⋯ → Stop…**, or start a fresh fixture after the Settings check.
  Stopping ends the live fixture prerequisite; it is not an approval or a successful decision.
- **Classic:** `/classic` on the same test host/port; More links reach that dashboard. Interactive surfaces remain
  available only through the existing **Open in classic pop-out**. Stay in `/chat` for native checks below.

## Set appearance and screen reader explicitly

**iPhone:** use Settings → Appearance (or **Display & Brightness** on iOS 26 and earlier), choose **Light** for the
first pass and **Dark** for the second; turn Automatic off during testing. Return to Safari and confirm the page
appearance changes. Control Center's brightness control also offers Dark Mode. [Apple appearance instructions](https://support.apple.com/en-us/108350).

**Android:** use Settings → Accessibility → Colour and motion → **Dark theme**, off for Light and on for Dark
(labels vary by manufacturer; Settings search for “Dark theme” finds it). Use the standard theme rather than
colour inversion/forced darkening and disable its schedule during testing. Return to Chrome and confirm the
page changes. [Google appearance instructions](https://support.google.com/accessibility/android/answer/6151800?hl=en-PW).

**VoiceOver on/off:** Settings → Accessibility → **VoiceOver**, switch on for the reading pass, then return there
to switch off. While enabled, single-tap selects, double-tap activates and a three-finger swipe scrolls. Practise
the gestures before returning to Safari. [Apple VoiceOver instructions](https://support.apple.com/en-ie/guide/iphone/iph3e2e415f/ios).

**TalkBack on/off:** Settings → Accessibility → **TalkBack → Use TalkBack**, enable and confirm for the reading
pass. When finished, return to that switch and turn it off/confirm. With TalkBack enabled, touch selects,
double-tap activates, one-finger swipes move focus and two-finger swipes scroll. A configured volume-key shortcut
may toggle it, but is not assumed. [Google enable instructions](https://support.google.com/accessibility/android/answer/6007100?hl=en&rd=2),
[Google disable instructions](https://support.google.com/accessibility/android/answer/14252950?hl=en).

## Physical verification steps (repeat all in each device/appearance)

1. **Find requests.** Confirm both the rail line and footer show **2 waiting for you**. Tap the rail line; it closes
   the drawer and shows the waiting room card. Read the critical command/review evidence. Confirm there is a
   question card too, and no decision buttons in the rail or Members panel.
2. **Multi-line composer and history.** Tap the message field and type several lines without sending. With the
   native keyboard open, check that draft, Send and the Note target remain visible above it, without automatic
   focus zoom. Scroll history up: opening/closing the keyboard preserves that position. Follow newest, then
   reopen the keyboard: newest stays visible. Draft and target stay intact. Close the keyboard and check recovery.
3. **Critical typed confirmation.** Tap Approve once on the critical card. Cancel must get initial focus. Read the
   dialog, focus its text field and type the displayed word. Field, Cancel and Approve must remain reachable above
   the keyboard, including after it pans the page. **Cancel**, then confirm the item is still waiting and the
   opening card/control is reached again. Do not treat a local delivery message as a recorded receipt.
4. **Find Workspaces and scroll.** Use each entry once: the turn's visible Open workspace, rail Members link,
   and ⋯ → Workspaces link. Inspect coder-1's live terminal; it grows about every three seconds. Scroll up to pause
   following; long lines scroll internally. Jump to latest resumes. Select **turn 1** and read its changed file,
   captured diff and passed verification. Return to the room; check opening focus, draft and Note target.
5. **Rotation with keyboard.** Enable OS auto-rotation/unlock orientation. While editing the composer draft,
   rotate portrait → landscape → portrait. Field, Send and waiting bar remain above the keyboard; draft, target
   and room position survive. Repeat with the typed-confirm field focused, then **Cancel**. Reopen Workspace and
   check its internal scrolling after rotation.
6. **User zoom.** Pinch-zoom the page; verify zoom remains available and the app does not jump to compensate for
   the panned viewport. Read enlarged content and use controls; reset zoom before repeating keyboard checks.
7. **Screen reader.** Enable VoiceOver/TalkBack using the instructions above. Navigate room headings, waiting
   indicators and the two cards. Check names, count, review evidence and accessible Workspace links. Open the
   critical sheet: confirm the safe initial choice, field access and return after Cancel. Live terminal output
   must not flood announcements. In the disposable fixture only, answer the question if needed to observe a
   server-recorded count change from 2 to 1 without duplicate chatter; restart before the next pass.
8. **Settings keyboard (last, because it changes prerequisites).** After other checks, Stop the disposable active
   session via ⋯ → Stop… and confirm. Check server-recorded termination, then open the composer gear. Type a draft,
   open Settings, expand Advanced and focus **Turn limit** so the native keyboard opens. Field, sheet and Close
   must remain reachable above it. Close and confirm the draft remains. Rotate with the field focused and repeat.
   Restart the fixture before testing the next appearance/device. No new session submission is required.

## Results — only performed checks count

Every result must be **Pass**, **Fail** with reproduction notes, or **Not performed**. A blank or Not performed is
never a pass. Attach device/browser versions, appearance, keyboard, zoom state, steps, screenshot and expected
versus actual result for failures. Only the owner may clear G3 or accept a listed failure.

### Round 1 — owner report, 2026-10-02 (preserved; not a round-2 result)

Device/OS/browser versions and per-platform attribution were not supplied; owner fills them in. The reported
observations are recorded once below rather than inferred as separate passes/failures for each platform.

| Check | Result | Owner-reported notes |
|---|---|---|
| Composer | **Fail** | Message field did not remain visible |
| Approvals discovery | **Fail** | Not found in chat; pending critical-permission prerequisite missing |
| Workspace discovery | **Fail** | Not found in chat |
| Rotation | **Pass** | Performed; must be re-run with the keyboard after M9.1 |
| Screen reader | **Not performed** | VoiceOver/TalkBack not checked |
| Light/dark | **Not performed** | Appearance passes not checked |
| Settings keyboard | **Not performed** | No result supplied |
| Typed confirmation | **Not performed** | Prerequisite missing; no result supplied |
| Terminal scrolling | **Not performed** | Workspace not found; no result supplied |
| User zoom | **Not performed** | No result supplied |

### Round 2 — awaiting owner, after M9.1 and Opus review

| Platform / device | OS / browser / reader versions | Appearance | Find requests | Composer | Typed confirm | Workspace / terminal | Rotation | Zoom | Screen reader | Settings | Date / notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| iOS Safari / owner to supply | Owner to supply | Light | Not performed | Not performed | Not performed | Not performed | Not performed | Not performed | Not performed | Not performed | Owner to supply |
| iOS Safari / owner to supply | Owner to supply | Dark | Not performed | Not performed | Not performed | Not performed | Not performed | Not performed | Not performed | Not performed | Owner to supply |
| Android Chrome / owner to supply | Owner to supply | Light | Not performed | Not performed | Not performed | Not performed | Not performed | Not performed | Not performed | Not performed | Owner to supply |
| Android Chrome / owner to supply | Owner to supply | Dark | Not performed | Not performed | Not performed | Not performed | Not performed | Not performed | Not performed | Not performed | Owner to supply |
