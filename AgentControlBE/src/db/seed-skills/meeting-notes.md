---
name: meeting-notes
description: Turn a supplied meeting transcript into decisions, open questions, and action items, with key decisions optionally kept in memory. Use for meeting records grounded in the provided text.
---

# Meeting Notes

Produce a faithful meeting record from supplied text or an identified workspace note. Separate decisions from proposals and track unresolved questions.

## Workflow

1. Locate the transcript in the user's input. If none is available, request it; do not invent a meeting.
2. Extract a short summary, confirmed decisions, action items, and open questions. Include owners and due dates only when the source establishes them; otherwise mark them “unspecified”.
3. Preserve disagreement and uncertainty. Quote short source phrases when needed to support a disputed decision or deadline.
4. Return the structured record in the reply. When the user asks you to keep a decision for later and `remember` is available, save one short fact per decision with category `work`.
5. If updating an existing meeting record, read it first and target its exact ID. Only the authoring agent may replace it; append uses body only, with no title or tags. Report persistence only after a successful save.

## Example

Source: “Sam: I will test the patch by Friday. Lee: We agreed to keep the old API until the migration is complete.”

Record the API retention as a decision and the test as an action owned by Sam. Preserve “Friday” verbatim if the meeting date is unknown; do not fabricate a calendar date.

To keep the decision for later, call `remember` with `{"text":"API migration: keep the old API until migration is complete.","category":"work"}`.

## Limits

This skill does not record audio, attend meetings, retrieve external calendars, assign tasks, send messages, or schedule reminders. An action item in the record is written text, not an executable task. Memory holds short facts (500 characters each), not full transcripts.
