---
name: meeting-notes
description: Turn a supplied meeting transcript into decisions, open questions, and action items, optionally saved as a local note. Use for meeting records grounded in the provided text.
tools: list_notes, read_note, save_note
---

# Meeting Notes

Produce a faithful meeting record from supplied text or an identified workspace note. Separate decisions from proposals and track unresolved questions.

## Workflow

1. Locate the transcript in the user's input or use `list_notes` and `read_note` to retrieve the requested note. If none is available, request it; do not invent a meeting.
2. Extract a short summary, confirmed decisions, action items, and open questions. Include owners and due dates only when the source establishes them; otherwise mark them “unspecified”.
3. Preserve disagreement and uncertainty. Quote short source phrases when needed to support a disputed decision or deadline.
4. Return the structured record. When the user asks to save it, call `save_note` with the generated record as a literal body, a meaningful title, `mode:"create"`, and a `meeting` tag.
5. If updating an existing meeting record, read it first and target its exact ID. Only the authoring agent may replace it; append uses body only, with no title or tags. Report persistence only after a successful save.

## Example

Source: “Sam: I will test the patch by Friday. Lee: We agreed to keep the old API until the migration is complete.”

Record the API retention as a decision and the test as an action owned by Sam. Preserve “Friday” verbatim if the meeting date is unknown; do not fabricate a calendar date.

To save the extracted record, call `save_note` with `{"title":"API migration meeting","body":"Decision: Keep the old API until migration is complete.\nAction: Sam to test the patch by Friday (calendar date unspecified).","mode":"create","tags":["meeting","migration"]}`.

## Limits

This skill does not record audio, attend meetings, retrieve external calendars, assign tasks, send messages, or schedule reminders. An action item in a note is a written record, not an executable task. Notes are shared locally, limited to 20,000 body characters, 200 notes per workspace, and four successful writes per run. Do not use `@input` as the saved body when the user asked for a synthesized record instead of a verbatim transcript.
