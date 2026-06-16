# Interactive `/loop` Command

Status: REVISED. The recurring/scheduling behavior moved server-side — see
[`loop-engine.md`](./loop-engine.md). `/loop` is now a **thin client** that
parses the command and calls the server loop engine; loop iterations run as
**background subagents** and do not intercept the foreground session. The
client-side timer/controller described below is superseded by the engine and
will be removed; only the parsing, `/loop` autocomplete entry, and feedback
remain. Read `loop-engine.md` first.

## Goal

A `/loop` slash command, available in **interactive mode**, that re-runs a
prompt (or another slash command) repeatedly in the current session — the
opencode equivalent of Claude Code's `/loop`.

```
/loop 5m check the build and fix any failures   # run now, then every 5 minutes
/loop fix all the type errors                    # no interval = self-paced
/loop /review                                    # loop another slash command
/loop stop                                       # cancel the active loop
```

Two surfaces, same semantics (per the product decision):

1. **Main TUI** (`packages/tui`) — the default `opencode` / `ocod` experience.
2. **`opencode run --interactive`** split-footer mode (`runtime.queue.ts`).

Design intent: behave **exactly like Claude Code's `/loop`** — re-run one fixed
prompt/command on a recurring interval, self-pace when no interval is given, and
run **until the user manually stops it**. No time/idle-based auto-stop.

## Remote control & why SessionPubSub is removed

The original `SessionPubSub` (PR #3) existed to let people "send and receive
messages remotely and control a running session" via an in-process Effect
queue. That is redundant: a loop that re-runs a prompt like
`/loop 30s check my telegram inbox and reply to new messages` achieves remote
send/receive/control using the **existing external inbox infrastructure**
(telegram bridge, `inbox.ndjson`, SSH) — no in-process pub/sub needed.

Decision: **delete `SessionPubSub`** and serve the remote-control use case with
`/loop`. See [`session-pubsub-removal.md`](./session-pubsub-removal.md) for the
removal plan. The loop itself does **not** ingest external messages; remote I/O
is whatever the looped prompt does.

## Current State (what's wrong)

`--loop` today is a flag on the **headless** `run` command, implemented as a
Node `readline` REPL over stdin:

- `packages/opencode/src/cli/cmd/run.ts:228-234` — `--loop/-l` option.
- `packages/opencode/src/cli/cmd/run.ts:830-862` — opens `readline`, prints
  `> `, and submits each stdin line as one turn until empty line / EOF.

Problems:

- It only works in **non-interactive** `run` (no TUI). The interactive TUI
  already does plain multi-turn (type → respond → type), so the headless REPL
  adds nothing for interactive users.
- It is **not a command** — it is a process-level mode selected by a flag.
- It is **not recurring** — it waits for the *user* to type the next line; it
  does not re-run the same prompt on an interval, and it does not self-pace off
  session idle.

Action: remove the `--loop` flag and its readline branch from `run.ts`; replace
with the `/loop` command described here. (Keep the `oy` headless yolo alias
working — it never used `--loop`.)

## Behavior

### Syntax

```
/loop [<interval>] <prompt text | /command [args]>
/loop stop          # alias: /loop off, /unloop
/loop               # with no args: show loop status (active? interval? prompt?)
```

- `<interval>` is optional and matches a duration: `30s`, `5m`, `1h`,
  `90s`, `2m30s`. If the first token parses as a duration it is the interval;
  otherwise the whole remainder is the prompt.
- The body after the interval is either free text (a normal prompt) or a
  slash command (dispatched the same way the TUI dispatches `/review` etc.).

### Run modes

- **Interval mode** (`/loop 5m <prompt>`): submit the prompt immediately, then
  re-submit every `interval`. If the session is still busy when the timer
  fires, **skip that tick** (do not stack turns) and try again next interval.
- **Self-paced mode** (`/loop <prompt>`, no interval): submit the prompt, then
  re-submit as soon as the session returns to **idle** (driven by the
  `session.status` idle / `session.idle` event — see
  [session lifecycle](./session-pubsub-lifecycle.md)). Add a small floor delay
  (e.g. 500ms) to avoid a hot spin if a turn returns instantly.

### One loop per session

At most one active loop per session. Issuing a new `/loop ...` while one is
active replaces it (and echoes "replaced active loop"). `/loop stop` cancels it.

### Stop conditions (all cancel the loop)

The loop runs **until explicitly stopped** — there is **no idle/time-based
auto-stop** (matches Claude's `/loop`). It is cancelled only by:

- `/loop stop` (or `/loop off`, `/unloop`) — the normal manual stop.
- User presses the interrupt/abort key (Esc) — aborting the running turn also
  cancels the loop, so a single Esc both stops the current turn and the loop.
- `/new` (new session) or switching sessions.
- Session deleted / aborted, or the TUI/`run` process exits.
- An errored turn cancels the loop and surfaces the error (do not keep looping
  on a failing prompt).

### Visible feedback

- On start: a system/footer line — `looping every 5m: "<prompt>"` or
  `looping (self-paced): "<prompt>"`.
- Each iteration is a normal turn in the transcript (no special rendering
  required for v1).
- On stop: `loop stopped`.

## Design

The loop is **client-side** state, not a server prompt template. It is a
scheduler that submits existing prompts/commands through the paths each surface
already uses. Nothing new is needed on the server for v1.

### Shared core

Add a small surface-agnostic helper (e.g.
`packages/opencode/src/cli/cmd/run/loop.ts` for the run surface, mirrored in
the TUI) that owns:

- `parseLoop(input): { interval?: Duration; body: string; command?: {...} } | { stop: true } | { status: true }`
- a `LoopController` with `start(spec, submit, onIdleStream)`, `stop()`, and
  `isActive()`, where:
  - interval mode uses a timer; on each tick, if not busy, call `submit(body)`.
  - self-paced mode subscribes to the session-idle event and calls
    `submit(body)` on each idle (debounced by the floor delay).
  - `submit` is provided by the surface (it knows how to send a prompt vs a
    `/command`).

Reuse the existing duration parser if one exists; otherwise a tiny `Ns/Nm/Nh`
parser. Reuse the slash-command detection already present in the TUI prompt
component.

### Surface 1 — Main TUI (`packages/tui`)

- Detect `/loop` in the prompt submit handler alongside the existing shell /
  slash-command branches at
  `packages/tui/src/component/prompt/index.tsx:1055-1110`. `/loop` is handled
  **locally** (like shell mode) — it does **not** go through
  `session.command`.
- `submit(body)` reuses the same code path the component uses for a normal
  prompt (`session.prompt`, `index.tsx:1088-1110`) or, when the body is itself
  a slash command, the `session.command` path (`index.tsx:1077-1086`).
- Self-paced mode subscribes to the session idle event from the TUI's sync
  stream (`packages/tui/src/context/sync.tsx`).
- Cancel on Esc/abort, `/new`, session switch, and unmount.

### Surface 2 — `run --interactive` (split-footer)

- Add `/loop` (+ `/loop stop`) to the local command handling next to `/new`,
  `/exit`, `/quit` in `packages/opencode/src/cli/cmd/run/runtime.queue.ts`
  (parsing helpers live in
  `packages/opencode/src/cli/cmd/run/prompt.shared.ts:45-52`).
- `submit(body)` enqueues into the existing serial prompt queue
  (`runtime.queue.ts` drain → `runtime.ts:640-687` `runPromptTurn`). Because
  the queue is already serial, interval ticks that arrive mid-turn naturally
  wait; still apply the "skip if a tick is already queued" guard to avoid
  unbounded queue growth.
- Self-paced mode triggers the next enqueue when the queue drains to idle.
- Optionally surface `/loop` in the slash autocomplete panel
  (`packages/opencode/src/cli/cmd/run/footer.command.tsx`).

## Edge cases

- Interval shorter than a turn → ticks are skipped while busy; effectively
  self-paced. Documented, not an error.
- `/loop` with no body and no active loop → print usage, do nothing.
- `/loop stop` with no active loop → print "no active loop".
- Body that is an unknown `/command` → surface the same "command not found"
  error the normal command path produces, and do not start the loop.
- Process/TUI exit must clear timers and unsubscribe (no leaked fibers/timers).

## Acceptance criteria

- `--loop` flag and its readline branch are removed from `run.ts`; `run --help`
  no longer lists `-l, --loop`.
- In the main TUI: `/loop 5m <p>` runs `<p>` now and again after ~5m; `/loop <p>`
  reruns on idle; `/loop stop` cancels; Esc cancels; `/new` cancels.
- In `run --interactive`: same four behaviors via the footer.
- Only one loop per session; a second `/loop` replaces the first.
- A failing turn stops the loop and shows the error.
- No leaked timers or event subscriptions after stop / exit (verify by
  starting+stopping a loop and confirming idle CPU and that abort/exit is clean).
