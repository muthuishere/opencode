# Fork Additions — what this fork adds on top of upstream opencode

This is the index/overview of everything layered on top of stock opencode in
this fork (`github.com/muthuishere/opencode`, branch `dev`). Per-feature detail
lives in the linked specs; this page is the map.

Baseline = upstream opencode at commit `5d0f86606` ("fix(mcp): stop idle OAuth
callback server"). Everything below is on top of that.

## Summary of features

| # | Feature | Status | Detail spec |
|---|---------|--------|-------------|
| 1 | `-s` session picker (+ `/sessions` command) | added, bug-fixed | this doc §1 |
| 2 | `/loop` interactive command (TUI + `run --interactive`) | added | [`interactive-loop-command.md`](./interactive-loop-command.md) |
| 3 | Loop engine + `loop`/`loop_stop`/`loop_list` tools (background-subagent loops) | added | [`loop-engine.md`](./loop-engine.md) |
| 4 | SessionPubSub | removed | [`session-pubsub-removal.md`](./session-pubsub-removal.md) |
| 5 | Local build + install tooling (`ocode`/`ocod`) | added (outside repo) | this doc §5 |

History note: features 1–3 began as three Copilot PRs merged into `dev`
(PR #1 session picker, PR #2 a headless `--loop` flag, PR #3 `SessionPubSub`).
PR #2 and PR #3 were reworked: the headless `--loop` flag was removed and
replaced by the `/loop` command + tool-driven loop engine; `SessionPubSub` was
deleted as redundant. PR #1 was kept and fixed.

---

## 1. `-s` session picker

Run `opencode -s` (no id) to open an interactive **session picker**; `opencode
-s <id>` continues a specific session. Also exposed as a `/sessions` slash
command in the TUI.

- CLI flag: `cli/cmd/tui.ts` — `session` option with `alias: ["s"]`,
  `requiresArg: false`. A valueless `-s` opens the picker; a value continues
  that session.
- TUI: `args.sessionPicker` (added to `tui/src/context/args.tsx`) opens
  `DialogSessionList` (`tui/src/app.tsx`), which lists sessions for the current
  directory by default (toggle: `app.toggle.session_directory_filter`).

**Bug fixed in this fork:** the original PR detected the picker with
`args.session === true`, but a string-typed `-s` with `requiresArg:false`
yields `""` from yargs (never `true`), so the picker never opened. Fixed in
`cli/cmd/tui.ts`:

```ts
const rawSession = args.session as string | boolean | undefined
const sessionID = typeof rawSession === "string" && rawSession.length > 0 ? rawSession : undefined
const sessionPicker = rawSession === "" || rawSession === true
```

Files: `cli/cmd/tui.ts`, `tui/src/app.tsx`, `tui/src/context/args.tsx`,
`tui/src/context/sync.tsx`.

---

## 2. `/loop` interactive command

A Claude-Code-style `/loop` command in **both** interactive surfaces:

```
/loop 2m check the build and fix failures   # run on a 2-minute timer
/loop fix all the type errors               # no interval = self-paced
/loop /review                               # loop another slash command
/loop                                       # show active loops (status)
/loop stop                                  # cancel (aliases: off, /unloop)
```

It is a **thin client**: it parses the command and calls the server-side loop
engine (§3) over the SDK; it owns no timers. Loops run as background subagents,
so `/loop` never takes over the foreground conversation.

Surfaces & files:
- Main TUI: `tui/src/component/prompt/loop.ts` (parser),
  `tui/src/component/prompt/index.tsx` (intercept + SDK calls),
  `tui/src/component/prompt/autocomplete.tsx` (`/loop` dropdown entry),
  `tui/test/prompt/loop.test.ts` (parser tests).
- `run --interactive`: `cli/cmd/run/loop.ts` (parser),
  `cli/cmd/run/runtime.queue.ts` + `runtime.ts` (intercept + SDK calls),
  `cli/cmd/run/footer.command.tsx` (autocomplete entry).

The upstream-merged **headless `--loop` flag was removed** from
`cli/cmd/run.ts` (it was a stdin readline REPL — wrong design).

Full behavior: [`interactive-loop-command.md`](./interactive-loop-command.md).

---

## 3. Loop engine + tools (the core)

Server-side engine that runs a loop's iterations in a **persistent background
subagent session**, re-prompted on a schedule, posting a one-line toast to the
parent session each iteration. Two entry points:

1. **Model tools** — `loop`, `loop_stop`, `loop_list` (`tool/loop.ts`,
   registered in `tool/registry.ts`). The `loop` tool description steers the
   model to call it when the user says "every N minutes / keep checking / on a
   loop / in the background / as a bg agent" — so natural-language requests
   start a real loop instead of the model hand-rolling a bash script.
2. **`/loop` command** (§2) via HTTP endpoints.

Engine: `session/loop.ts` (service `SessionLoop` with `start`/`stop`/`list`),
wired as a `LayerNode` in `server/routes/instance/httpapi/server.ts`.

HTTP/SDK surface (added to the `session` group):
- `POST /session/:id/loop` → `sdk.client.session.loop({ sessionID, prompt, interval?, agent? })` → `{ loopID, bgSessionID, mode }`
- `POST /session/:id/loop/stop` → `sdk.client.session.loopStop({ sessionID, loopID? })` → `{ stopped }`
- `GET  /session/:id/loop` → `sdk.client.session.loopList({ sessionID })` → `LoopInfo[]`

Files: `session/loop.ts`, `tool/loop.ts`, `tool/registry.ts`,
`effect/app-runtime.ts`, `server/.../groups/session.ts`,
`server/.../handlers/session.ts`, `server/.../server.ts`; regenerated SDK
(`packages/sdk/js/src/v2/gen/*`).

Key behaviors: interval mode (skip a tick if the bg session is still busy),
self-paced mode (~500ms floor), persistent bg session (continuity across
iterations), one-line toast per iteration (never pollutes the parent
transcript), teardown on `loop_stop` / `/loop stop` / parent session
delete / abort. Runs until stopped — no idle auto-stop.

**Implementation gotcha (documented for future maintainers):** the engine
depends on `SessionPrompt`, which depends on `ToolRegistry`, which holds the
loop tool — a static import of `SessionPrompt` from `session/loop.ts` created a
module-init cycle (TDZ: "Cannot access 'defaultLayer' before initialization")
once `SessionLoop` was added to `AppLayer`. Resolved by importing
`SessionPrompt` lazily (dynamic import via the `AppRuntime` boundary) at
re-prompt/cancel time instead of as a static layer dependency. Typecheck does
NOT catch this — verify with `bun run --cwd packages/opencode dev generate`.

Full design: [`loop-engine.md`](./loop-engine.md).

---

## 4. SessionPubSub — removed

PR #3 added `session/pubsub.ts` (an in-process per-session prompt queue) for
remote send/receive control of a session. It was deleted: the use case is
served by `/loop` + the loop engine plus existing external inbox infrastructure
(no in-process pub/sub needed), and it had no callers beyond its layer
registration. Removal: deleted `session/pubsub.ts`, removed its import +
`SessionPubSub.node` from `server.ts`.

Detail: [`session-pubsub-removal.md`](./session-pubsub-removal.md).

---

## 5. Local build + install tooling (outside the repo)

Not part of the opencode source, but how this fork is run locally:

- `Taskfile.yml` at the repo root (git-excluded via `.git/info/exclude`):
  `task install` runs `bun install` → `bun run --cwd packages/opencode build
  --single` (single = current platform only), then symlinks the built binary to
  `~/muthu/pathextra/ocode`.
- `~/muthu/pathextra` is on `PATH`; `ocod` is a shell alias =
  `OPENCODE_PERMISSION='{"*":"allow"}' ~/muthu/pathextra/ocode` (interactive TUI
  with all permissions auto-allowed). Default config / model
  (`~/.config/opencode/opencode.json`) is used as-is.
- Rebuild after any source change with `task install`.

---

## Verification status

- typecheck clean (`packages/opencode`, `packages/tui`); full `task install`
  build + smoke test pass; SDK regenerated.
- Loop engine verified end-to-end over HTTP (create session → start loop →
  list → bg child session created → stop → list empty).
- `-s` picker logic fixed (yargs `""` behavior verified) — interactive render
  confirmed by the user.
- `/loop` and the loop tools confirmed working by the user in the live TUI.
