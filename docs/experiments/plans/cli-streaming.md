---
summary: "Plan: Enable Claude Code CLI streaming responses"
owner: "moltbot"
status: "draft"
last_updated: "2026-01-30"
---

# CLI Provider Streaming Plan

## Context

When the agent uses a CLI provider (e.g. Claude CLI via `claude-cli` backend), Moltbot currently runs the CLI with `runCommandWithTimeout`, buffers all stdout until the process exits, then parses the full output as JSON/JSONL. The embedded Pi path, by contrast, streams assistant text via `subscribeEmbeddedPiSession` and `emitAgentEvent`, so gateways and UIs see incremental updates. CLI runs return the same `EmbeddedPiRunResult` shape but only at the end—no streaming.

Claude CLI (and similar backends) can emit JSONL lines to stdout as the model responds. We do not currently consume those lines incrementally.

## Goals

- Consume CLI stdout incrementally (line-by-line or chunk-by-chunk).
- Emit the same stream events the embedded path uses (`assistant` text deltas, lifecycle) so gateways and UIs behave consistently for CLI providers.
- Keep the existing contract: `runCliAgent` still returns `Promise<EmbeddedPiRunResult>`; only the delivery of intermediate events changes.

## Non-goals

- Changing gateway/OpenResponses or other HTTP contracts.
- Streaming for other CLI backends (e.g. codex) in the first pass; can be added later using the same pattern.
- Changing how final payloads/meta are built.

## Scope (moderate)

Roughly 1–2 days. No change to “how major” the feature is from an API perspective.

### 1. Process layer: stream stdout

- **Option A:** Add a helper in `src/process/exec.ts`, e.g. `runCommandWithStreamingStdout(argv, options, { onStdoutLine })`, that:
  - Spawns the process.
  - Buffers stdout by line (or chunk), invokes `onStdoutLine` for each complete line.
  - Preserves existing timeout/kill and stderr handling.
  - Resolves with `{ code, signal, stdout, stderr }` when the process exits.
- **Option B:** Implement spawn + readline inside `cli-runner.ts` and reuse timeout/kill logic from `exec.ts`.

Estimate: ~50–80 lines (Option A in exec) or equivalent in cli-runner (Option B).

### 2. CLI runner: incremental JSONL and events

- In `src/agents/cli-runner.ts`:
  - Add optional `onAgentEvent?: (evt) => void` to `runCliAgent` (same shape as embedded path).
  - Replace `runCommandWithTimeout` with the streaming runner. For each stdout line:
    - Parse one JSONL line (reuse logic from `parseCliJsonl`: sessionId, usage, `item.text` / `item.type`).
    - When new assistant text is available: call `emitAgentEvent({ runId, stream: "assistant", data: { text: accumulated, delta } })` (and optionally `onPartialReply` if added).
  - On process exit: call `onAgentEvent({ stream: "lifecycle", data: { phase: "end", ... } })` (and `emitAgentEvent` for lifecycle if we want parity with embedded).
  - Continue building the same `EmbeddedPiRunResult` (payloads, meta) from accumulated text/sessionId/usage and return it at the end.
- In `src/agents/cli-runner/helpers.ts`: add a small helper that parses a **single** JSONL line and returns `{ sessionId?, text?, usage?, type? } | null` so the runner can emit per line without duplicating logic.

Estimate: ~80–120 lines in cli-runner and a small helper in helpers.

### 3. Command layer: pass lifecycle callback for CLI

- In `src/commands/agent.ts`, where `runCliAgent` is called (~lines 390–406), pass `onAgentEvent` (the same callback passed to `runEmbeddedPiAgent` that sets `lifecycleEnded` on `"end"` / `"error"`), so CLI runs also drive lifecycle and dependent logic.

Estimate: ~5–10 lines.

### 4. What stays unchanged

- Gateway, OpenResponses, or other HTTP/stream contracts.
- `EmbeddedPiRunResult` or any callers that only consume the final result.
- Other CLI backends until we choose to add streaming for them.

### 5. Risks / details

- **Partial lines:** Buffer stdout until newline before parsing JSONL; handle any trailing partial line on exit.
- **Timeout:** The streaming runner must still kill the process after `timeoutMs` (reuse or mirror logic in `exec.ts`).
- **Stderr:** Minimal change is to keep current behaviour (aggregate at the end).
- **SessionId:** May appear in the first JSONL line; accumulate and use for meta and for any events that need it.

## References

- Current CLI path: `src/agents/cli-runner.ts` (uses `runCommandWithTimeout`, then `parseCliJson` / `parseCliJsonl`).
- Process helper: `src/process/exec.ts` (`runCommandWithTimeout`).
- JSONL parsing: `src/agents/cli-runner/helpers.ts` (`parseCliJsonl`, `pickSessionId`, etc.).
- Embedded streaming: `src/agents/pi-embedded-subscribe.ts`, `pi-embedded-subscribe.handlers.messages.ts`; `runEmbeddedPiAgent` params `onAgentEvent`, `onPartialReply` in `src/agents/pi-embedded-runner/run/params.ts`.
- Caller that chooses CLI vs embedded: `src/commands/agent.ts` (`runWithModelFallback`, `runCliAgent` vs `runEmbeddedPiAgent`).

## Decision

To be implemented later; this document captures the plan for when we pick it up.
