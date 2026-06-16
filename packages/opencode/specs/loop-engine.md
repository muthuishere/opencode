# Loop Engine — server-side background-subagent loop runner

Status: draft. This supersedes the client-side-only design in
[`interactive-loop-command.md`](./interactive-loop-command.md) and is the agreed
architecture going forward.

## Goal

A "loop" re-runs a prompt/command on a schedule. Each iteration is executed by a
**background subagent**, so a loop **never intercepts the foreground session** —
the conversation you are in is not taken over or interrupted by loop turns.

Created two ways, both hitting the same engine:

1. **Model tool** (`loop` / `loop_stop`) — so natural language works:
   "loop my gh prs every 2 minutes" → the model calls the `loop` tool instead of
   improvising a bash script.
2. **`/loop` slash command** — interactive sugar that calls the same engine
   (thin client; no client-side timers).

## Why this shape

- A model tool call runs **server-side inside one turn and returns
  immediately**, so a recurring loop needs a **server-side scheduler that
  persists across turns**. (This is the capability `SessionPubSub` was reaching
  for; we build it fresh and purpose-built — we do not revive pubsub's code.)
- "Should not intercept" → loop iterations run in a **separate background
  subagent session**, not the foreground session. The foreground only ever sees
  compact, non-blocking notifications.
- The earlier client-side `/loop` timers (run + TUI) are **replaced** by this
  engine. We keep their parsing + feedback; we drop their local timers.

## Core model

- A **loop** = `{ id, parentSessionID, interval?, prompt, agent?, bgSessionID }`.
- Each loop owns ONE **persistent background session** (the subagent), created
  as a child of the parent session. Each tick **re-prompts that same background
  session** (continuity — it remembers prior iterations, e.g. "what PRs changed
  since last check"). Recommended over spawning a fresh subagent per tick.
- The engine keeps a per-(parent)session registry of active loops.

### Scheduling

- **Interval mode** (`interval` set, e.g. `2m`): every interval, if the loop's
  background session is idle, prompt it; if it is still busy, **skip the tick**
  (no stacking).
- **Self-paced** (no interval): prompt again after the previous iteration
  completes + a small floor delay (~500ms).
- Runs **until explicitly stopped** — no idle/time auto-stop (matches Claude).

### Background execution & non-interception

- The background session is a real subagent run via opencode's existing
  agent/task infrastructure (see `tool/task.ts`, the agent system, and
  `bypassAgentCheck`). It has its own transcript/scope.
- Loop iterations do **not** post turns into the parent transcript. Instead, on
  each iteration completion the engine emits a **compact notification** to the
  parent session (one line, e.g. `loop ab12 ✓ checked PRs — 1 new review`),
  non-blocking. Full iteration output is in the background session and
  retrievable on demand (`loop_list` / open the bg session).

### Lifecycle / teardown

- Loop starts when created (tool call or `/loop`).
- Torn down on: `loop_stop` / `/loop stop`, **parent session deleted**
  (`session.deleted`), or **parent session abort**. Teardown cancels timers,
  interrupts any in-flight background iteration, ends the background session,
  and removes the registry entry.
- Bind the scheduler + background sessions to the parent session scope so a
  global server teardown also cleans everything up (no orphaned timers/fibers).
- Note: the foreground "abort vs idle" ambiguity from the old pubsub plan is
  moot here — loop scheduling is decoupled from the foreground turn's idle.

## Tool surface (model-callable)

- `loop({ prompt: string, interval?: string, agent?: string })`
  → starts a loop; returns `{ loopID, bgSessionID, mode }`. `interval` like
  `30s`/`2m`/`1h`; omit = self-paced. `agent` optional (defaults to the
  general/subagent default). The tool returns immediately after scheduling.
- `loop_stop({ loopID?: string })` → stop one loop, or all loops in the session
  when `loopID` is omitted.
- `loop_list()` → active loops for the session (`{ loopID, prompt, interval,
  mode, lastRunAt, running }`).

Register these in the tool registry alongside the other tools. Keep their
descriptions tight so the model reaches for `loop` when the user says
"every N minutes / keep checking / on a loop / in the background".

## `/loop` slash command (thin client)

- Keep parsing `/loop [interval] <prompt | /command>`, `/loop stop`,
  `/loop` (status) in BOTH surfaces (TUI + `run --interactive`).
- Instead of a local timer, call the engine: `/loop 2m <p>` → server `loop(...)`;
  `/loop stop` → `loop_stop()`; `/loop` → `loop_list()` for status.
- **Remove** the client-side timer/controller logic added earlier
  (`packages/tui/src/component/prompt/loop.ts` timers and
  `packages/opencode/src/cli/cmd/run/loop.ts` timers). Retain only
  parsing/dispatch + feedback. The `/loop` autocomplete entry stays.

## File touch-points (for implementation)

- **New engine:** `packages/opencode/src/session/loop.ts` — registry,
  scheduler, background-session create + re-prompt, notifications, lifecycle.
  Subscribe to `session.deleted` (+ abort) for teardown. Wire as a `LayerNode`
  in the httpapi server layer group
  (`server/routes/instance/httpapi/server.ts`) — same slot pubsub used.
- **New tools:** `packages/opencode/src/tool/loop.ts` (`loop`, `loop_stop`,
  `loop_list`); register in the tool registry.
- **HTTP/SDK:** expose engine ops so the `/loop` command can call them
  (either dedicated routes or via the tools through the existing client).
- **Background subagent:** reuse `tool/task.ts` / agent infra to create and
  re-prompt the background session.
- **Client refactor:** `cli/cmd/run/loop.ts` and `tui .../prompt/loop.ts` become
  thin (parse + call engine; no timers).

## Acceptance criteria

- Prose "loop my gh prs every 2 min" → model calls `loop` tool → every 2 min a
  background subagent runs the prompt; the **foreground session is not
  interrupted** (only compact notifications appear).
- `/loop 2m <prompt>` does the same via the command, in both surfaces.
- Self-paced `/loop <prompt>` re-runs after each background iteration finishes.
- `loop_stop` / `/loop stop` / parent-session delete / abort all stop the loop
  and interrupt any in-flight background iteration.
- No client-side loop timers remain; no foreground transcript takeover.
- Server boots clean with the engine node; build + typecheck pass.

## Confirmed decisions

- **Background session:** PERSISTENT — one background subagent session per loop,
  re-prompted each tick so it carries memory across iterations.
- **Result surfacing:** ONE-LINE notification per iteration into the parent
  session (non-blocking); full iteration output stays in the background session
  and is retrievable via `loop_list` / opening the bg session.
