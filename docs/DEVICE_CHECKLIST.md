# Owner device checks before M9

M8 browser emulation verifies viewport layout, not native iOS/Android keyboards or assistive technology.
Run this checklist on a real iPhone with Safari and a real Android phone with Chrome. These results inform M9
sign-off; they are not an M8 acceptance gate. Record device, OS/browser versions and any failure below.

Use a test project with a current session, a pending critical permission and a Workspace containing terminal output.
Connect to `/chat` with the dashboard key. Repeat each step on both devices and in light/dark appearance.

1. **Multi-line composer.** Tap the composer and type several lines without submitting. With the OS keyboard
   open, check that the draft, Settings and Send stay reachable above it. Scroll the conversation and return to
   the draft; confirm that text and the correct session target remain intact.
2. **Settings with keyboard.** Open Settings from that draft. Focus an editable numeric setting so the native
   keyboard is open. Check that the sheet, focused field and Close remain reachable; close it and check the draft.
3. **Typed confirmation.** Open Approve on the pending critical permission. Read the review evidence. Focus the
   confirmation field and type the displayed word; check that the field and Cancel/Approve stay reachable above
   the keyboard. Cancel this check and confirm that the item is still waiting.
4. **Workspace scrolling.** Open a recorded agent Workspace, select an earlier turn and scroll its terminal with
   touch. Check that long lines scroll inside the terminal, navigation remains reachable, and Jump to latest
   returns to the newest output. Return to the room and check the composer target/draft.
5. **Rotation with keyboard.** While editing the multi-line composer draft, rotate portrait → landscape → portrait.
   Check the composer and waiting pointer above the keyboard, internal terminal scrolling when revisited, and
   preservation of the draft, target and room position. Repeat while editing a typed-confirm field, then Cancel.
6. **VoiceOver (iOS) / TalkBack (Android).** Enable the platform screen reader. Navigate the room headings, waiting
   pointer and a decision card. Check meaningful control names, review evidence, correct waiting count, and
   announcement of connection/count changes without duplicate chatter. Open a decision sheet: confirm the safe
   initial choice, access to the confirmation field, and return to the opener after Cancel. Check that live terminal
   output does not flood announcements.

Leave results blank until the checks have actually been performed. Attach reproduction steps for failures.

| Platform / device | OS / browser versions | Appearance | Composer | Settings | Typed confirm | Terminal | Rotation | Screen reader | Date / notes |
|---|---|---|---|---|---|---|---|---|---|
| iOS Safari / | | | | | | | | | |
| Android Chrome / | | | | | | | | | |
