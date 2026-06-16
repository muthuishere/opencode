# Remove SessionPubSub

Status: draft. Supersedes the earlier `session-pubsub-lifecycle.md` plan.

## Decision

**Delete `SessionPubSub` entirely.** Its purpose — letting people send/receive
messages remotely and control a running session — is served instead by the
[`/loop` command](./interactive-loop-command.md) plus the existing external
inbox infrastructure (telegram bridge, `inbox.ndjson`, SSH). There is no need
for an in-process per-session pub/sub queue.

We do **not** pursue the session-scoped-worker-lifecycle redesign that
`session-pubsub-lifecycle.md` described; that file is obsolete and should be
removed along with the code.

## Why

- `SessionPubSub` (added in PR #3) is an in-process Effect queue/worker per
  session for routing prompts in and replies out. It is only wired into the
  server layer and has **no callers** other than that registration — it is dead
  weight today.
- The remote-control use case is better expressed declaratively: the user runs
  e.g. `/loop 30s check ~/inbox.ndjson and reply to new messages`, and the
  loop's prompt drives whatever remote I/O is needed. The transport already
  exists outside opencode.
- Keeping it would also require the (non-trivial) lifecycle fixes and a new
  `session.aborted` event — cost with no consumer.

## Removal plan (code)

Revert the PR #3 footprint:

1. Delete `packages/opencode/src/session/pubsub.ts`.
2. In `packages/opencode/src/server/routes/instance/httpapi/server.ts`:
   - remove the import `import { SessionPubSub } from "@/session/pubsub"`
     (currently line ~36).
   - remove `SessionPubSub.node` from the `LayerNode.group([...])` list
     (currently line ~238).
3. Delete the obsolete spec `session-pubsub-lifecycle.md`.
4. Grep to confirm no other references remain:
   `grep -rn "SessionPubSub\|session/pubsub" packages/` → expect no hits.

## Verification

- Build succeeds (`task install` smoke test passes).
- `opencode serve` still boots and answers HTTP 200 (the layer group no longer
  contains `SessionPubSub.node` and must still initialize).
- No dangling imports / typecheck errors.

## Acceptance criteria

- `pubsub.ts` and `session-pubsub-lifecycle.md` are gone.
- `server.ts` no longer references `SessionPubSub`.
- Server boots clean; remote-control need is documented as handled by `/loop`.
