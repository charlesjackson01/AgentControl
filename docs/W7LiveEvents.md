# W7: live Hermes events (tabled)

**Status:** tabled. Pick this up after the probe below has been run on the server.

## Goal
Show Hermes (and the researcher, which also runs on Hermes) working **as it happens**. Today their workspace tabs show a call only once it ends.

## What exists today
- Hermes decisions and research questions are one-shot CLI calls (`agent-autonomy/adapters/hermes.py`). Output arrives when the process exits.
- The Hermes and researcher workspace tabs show the *recorded* call log (the request sent and the decision or report returned). They are labelled "not a live stream" (`agent-autonomy/workspace.js`, `renderWsLog`).
- Coders already stream live through OpenCode's transcript. W7 is only about the Hermes CLI.

## Proposed design
1. **Probe first; don't guess.** Add `agent-autonomy/spikes/hermes_stream_probe.py`, which:
   - runs one tiny call against the local model with `hermes chat --format stream-json`
   - prints each event's type and field names, but not the content of reasoning events

   Run it on the server. The event types Hermes v0.21.4 emits are unknown today, and the design below is fixed only from that output.
2. **Adapter.** When the probe says the format is supported:
   - Hermes runs with `--format stream-json`, and its stdout is read line by line.
   - Allowed event types become journal events of kind `Hermes stream`, carrying `agent` (`hermes` or `researcher-N`). Allowed means tool calls, tool results and assistant text.
   - **Reasoning parts are never stored**, by the same rule as `verify.transcript` for OpenCode.
   - Events are throttled and size-capped like transcripts.
3. **Same results.** The final answer is still parsed exactly as today: the decision JSON with one repair retry, and the research report. Run behaviour doesn't change, only visibility.
4. **Dashboard.** The Hermes and researcher workspace log renders `Hermes stream` events live and is labelled "live". The label goes away when the call ends. Without stream events, it falls back to today's recorded log.
5. **Fallback.** If the flag is missing, the format is unrecognised, or a line fails to parse, the call behaves exactly like today's one-shot call, and a single "live events unavailable" note is recorded.

## Constraints
- No private model reasoning is stored or shown.
- No simulated or fabricated output: only what Hermes actually emits.
- No extra model calls. The stream is the same call, read incrementally.
- The approvals, the researcher's credential guard (`roles.credential_refusal`, `web` toolsets only) and the decision contract are unchanged.
- There are no new dependencies (standard library only).

## Risks
- The `stream-json` format is undocumented and may change between Hermes versions. The adapter must tolerate unknown event types.
- Event volume on long calls: the throttle and caps above apply.
- With one GPU slot, Hermes streams interleave with coder turns. That's cosmetic, since the broker is unchanged.

## Acceptance criteria
- The probe output is recorded in this file, or in `docs/M0-SPIKE-REPORT.md`.
- A unit test parses captured sample lines from the probe, including unknown event types and dropped reasoning events.
- With a fake Hermes that streams a scripted sequence, the workspace shows the events live and never shows reasoning. The run's decisions are identical to the one-shot path.
- The existing Hermes decision and repair tests pass unchanged.
- One real run on the server shows live Hermes activity in its workspace.

## Size
About one milestone (1–2 days) once the probe output is in hand.
