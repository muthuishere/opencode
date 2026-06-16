import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { Effect, Fiber, Layer, Scope, Context, Duration } from "effect"
import * as Stream from "effect/Stream"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { Agent } from "../agent/agent"
import type { SessionPrompt } from "./prompt"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TuiEvent } from "@/server/tui-event"
import { ulid } from "ulid"

const DEFAULT_SUBAGENT = "general"
const SELF_PACED_FLOOR_MS = 500

export type LoopMode = "interval" | "self-paced"

export interface LoopInfo {
  readonly loopID: string
  readonly prompt: string
  readonly interval?: string
  readonly mode: LoopMode
  readonly running: boolean
  readonly lastRunAt?: number
}

export interface StartInput {
  readonly parentSessionID: SessionID
  readonly prompt: string
  readonly interval?: string
  readonly agent?: string
}

export interface StartResult {
  readonly loopID: string
  readonly bgSessionID: SessionID
  readonly mode: LoopMode
}

export interface StopInput {
  readonly parentSessionID: SessionID
  readonly loopID?: string
}

export interface StopResult {
  readonly stopped: number
}

interface LoopRecord {
  readonly loopID: string
  readonly parentSessionID: SessionID
  readonly bgSessionID: SessionID
  readonly prompt: string
  readonly interval?: string
  readonly intervalMs?: number
  readonly mode: LoopMode
  fiber?: Fiber.Fiber<void>
  running: boolean
  lastRunAt?: number
}

export interface Interface {
  readonly start: (input: StartInput) => Effect.Effect<StartResult>
  readonly stop: (input: StopInput) => Effect.Effect<StopResult>
  readonly list: (input: { parentSessionID: SessionID }) => Effect.Effect<LoopInfo[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionLoop") {}

/**
 * Parse a duration like "30s", "2m", "1h", "2m30s" into milliseconds.
 * Returns undefined for an empty/whitespace string and throws (defect) for
 * an unparseable value so the caller surfaces a clear error.
 */
export function parseInterval(interval: string): number {
  const trimmed = interval.trim()
  if (trimmed === "") throw new Error("empty interval")
  const matches = trimmed.toLowerCase().match(/(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g)
  if (!matches) throw new Error(`invalid interval: ${interval}`)
  let total = 0
  for (const part of matches) {
    const m = part.match(/(\d+(?:\.\d+)?)\s*(ms|s|m|h)/)
    if (!m) throw new Error(`invalid interval: ${interval}`)
    const value = Number(m[1])
    switch (m[2]) {
      case "ms":
        total += value
        break
      case "s":
        total += value * 1000
        break
      case "m":
        total += value * 60_000
        break
      case "h":
        total += value * 3_600_000
        break
    }
  }
  if (total <= 0) throw new Error(`invalid interval: ${interval}`)
  return total
}

function shortId(loopID: string) {
  return loopID.slice(-4)
}

function summarize(text: string) {
  const oneLine = text.replace(/\s+/g, " ").trim()
  if (oneLine.length <= 80) return oneLine
  return oneLine.slice(0, 77) + "..."
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service
    const agents = yield* Agent.Service
    const events = yield* EventV2Bridge.Service

    // SessionPrompt depends on the ToolRegistry graph, which closes an import
    // cycle back to app-runtime (where SessionLoop.defaultLayer lives). Reaching
    // it statically here would crash at init (TDZ). So we reach it lazily across
    // the AppRuntime boundary at call time, forwarding the same InstanceRef the
    // engine runs under so the bg-session prompt lands in the correct
    // per-directory instance (mirrors tool/loop.ts's runEngine pattern).
    const onAppRuntime = <A, E>(fn: (prompt: SessionPrompt.Interface) => Effect.Effect<A, E>): Effect.Effect<A> =>
      Effect.gen(function* () {
        const ctx = yield* InstanceRef
        const { AppRuntime } = yield* Effect.promise(() => import("@/effect/app-runtime"))
        const { SessionPrompt } = yield* Effect.promise(() => import("@/session/prompt"))
        return yield* Effect.promise(() =>
          AppRuntime.runPromise(SessionPrompt.Service.use(fn).pipe(Effect.provideService(InstanceRef, ctx))),
        )
      })

    const state = yield* InstanceState.make(
      Effect.fn("SessionLoop.state")(function* () {
        const scope = yield* Scope.Scope
        const loops = new Map<string, LoopRecord>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach([...loops.values()], (record) => teardown(record), {
              concurrency: "unbounded",
              discard: true,
            })
            loops.clear()
          }),
        )
        return { scope, loops }
      }),
    )

    // Idempotent: cancels the per-loop fiber, interrupts any in-flight
    // iteration, removes the background session. Safe to call repeatedly.
    const teardown = Effect.fn("SessionLoop.teardown")(function* (record: LoopRecord) {
      const fiber = record.fiber
      record.fiber = undefined
      record.running = false
      if (fiber) yield* Fiber.interrupt(fiber)
      yield* onAppRuntime((prompt) => prompt.cancel(record.bgSessionID)).pipe(Effect.ignore)
      yield* sessions.remove(record.bgSessionID).pipe(Effect.ignore)
    })

    const notify = Effect.fn("SessionLoop.notify")(function* (
      record: LoopRecord,
      variant: "info" | "error",
      text: string,
    ) {
      const mark = variant === "error" ? "✗" : "✓"
      yield* events
        .publish(TuiEvent.ToastShow, {
          message: `loop ${shortId(record.loopID)} ${mark} ${summarize(text)}`,
          variant,
          duration: 5000,
        })
        .pipe(Effect.ignore)
    })

    // One iteration: re-prompt the persistent background session and toast the
    // parent. Never posts into the parent transcript.
    const iterate = Effect.fn("SessionLoop.iterate")(function* (record: LoopRecord, agent: string) {
      record.running = true
      record.lastRunAt = Date.now()
      const result = yield* onAppRuntime((prompt) =>
        prompt.prompt({
          sessionID: record.bgSessionID,
          agent,
          parts: [{ type: "text", text: record.prompt }],
        }),
      ).pipe(Effect.exit)
      record.running = false
      if (result._tag === "Failure") {
        yield* notify(record, "error", String(result.cause))
        return
      }
      const text = result.value.parts.findLast((item) => item.type === "text")?.text ?? ""
      yield* notify(record, "info", text)
    })

    const scheduleInterval = Effect.fn("SessionLoop.scheduleInterval")(function* (
      record: LoopRecord,
      agent: string,
      intervalMs: number,
    ) {
      while (true) {
        const current = yield* status.get(record.bgSessionID)
        // Skip the tick when the background session is still busy (no stacking).
        if (current.type !== "busy") yield* iterate(record, agent).pipe(Effect.ignore)
        yield* Effect.sleep(Duration.millis(intervalMs))
      }
    })

    const scheduleSelfPaced = Effect.fn("SessionLoop.scheduleSelfPaced")(function* (record: LoopRecord, agent: string) {
      while (true) {
        yield* iterate(record, agent).pipe(Effect.ignore)
        yield* Effect.sleep(Duration.millis(SELF_PACED_FLOOR_MS))
      }
    })

    const start = Effect.fn("SessionLoop.start")(function* (input: StartInput) {
      const data = yield* InstanceState.get(state)

      const intervalMs = input.interval ? parseInterval(input.interval) : undefined
      const mode: LoopMode = intervalMs === undefined ? "self-paced" : "interval"

      const requested = input.agent ?? DEFAULT_SUBAGENT
      const resolved = yield* agents.get(requested)
      const agent = resolved?.name ?? DEFAULT_SUBAGENT
      const subagent = resolved ?? (yield* agents.get(DEFAULT_SUBAGENT))

      const parent = yield* sessions.get(input.parentSessionID).pipe(Effect.orDie)

      // Deny the background subagent the ability to itself spawn loops/tasks.
      const childPermission = subagent
        ? deriveSubagentSessionPermission({
            parentSessionPermission: parent.permission ?? [],
            subagent,
          })
        : []
      const childToolDenies = [
        { permission: "loop" as const, pattern: "*" as const, action: "deny" as const },
        { permission: "task" as const, pattern: "*" as const, action: "deny" as const },
      ]

      const snippet = summarize(input.prompt).slice(0, 48)
      const bg = yield* sessions.create({
        parentID: input.parentSessionID,
        title: `loop: ${snippet}`,
        agent,
        permission: [
          ...childPermission,
          ...childToolDenies.filter(
            (deny) =>
              !childPermission.some(
                (rule) =>
                  rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
              ),
          ),
        ],
      })

      const loopID = ulid()
      const record: LoopRecord = {
        loopID,
        parentSessionID: input.parentSessionID,
        bgSessionID: bg.id,
        prompt: input.prompt,
        interval: input.interval,
        intervalMs,
        mode,
        running: false,
      }
      data.loops.set(loopID, record)

      const work = intervalMs === undefined ? scheduleSelfPaced(record, agent) : scheduleInterval(record, agent, intervalMs)
      const fiber = yield* work.pipe(Effect.forkIn(data.scope, { startImmediately: true }))
      record.fiber = fiber

      return { loopID, bgSessionID: bg.id, mode } satisfies StartResult
    })

    const stop = Effect.fn("SessionLoop.stop")(function* (input: StopInput) {
      const data = yield* InstanceState.get(state)
      const targets = [...data.loops.values()].filter((record) => {
        if (record.parentSessionID !== input.parentSessionID) return false
        if (input.loopID && record.loopID !== input.loopID) return false
        return true
      })
      yield* Effect.forEach(
        targets,
        (record) =>
          Effect.gen(function* () {
            yield* teardown(record)
            data.loops.delete(record.loopID)
          }),
        { concurrency: "unbounded", discard: true },
      )
      return { stopped: targets.length } satisfies StopResult
    })

    const list = Effect.fn("SessionLoop.list")(function* (input: { parentSessionID: SessionID }) {
      const data = yield* InstanceState.get(state)
      return [...data.loops.values()]
        .filter((record) => record.parentSessionID === input.parentSessionID)
        .map(
          (record) =>
            ({
              loopID: record.loopID,
              prompt: record.prompt,
              interval: record.interval,
              mode: record.mode,
              running: record.running,
              lastRunAt: record.lastRunAt,
            }) satisfies LoopInfo,
        )
    })

    // Tear down loops whose parent (or background) session is deleted. Session
    // removal recurses to children and emits Deleted for the bg session too, so
    // teardown must be idempotent (it is).
    yield* Effect.gen(function* () {
      const data = yield* InstanceState.get(state)
      yield* events.subscribe(Session.Event.Deleted).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const deleted = event.data.sessionID
            const affected = [...data.loops.values()].filter(
              (record) => record.parentSessionID === deleted || record.bgSessionID === deleted,
            )
            yield* Effect.forEach(
              affected,
              (record) =>
                Effect.gen(function* () {
                  data.loops.delete(record.loopID)
                  yield* teardown(record)
                }),
              { concurrency: "unbounded", discard: true },
            )
          }),
        ),
      )
    }).pipe(Effect.ignore, Effect.forkScoped)

    return Service.of({ start, stop, list })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Session.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provide(Agent.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
)

export const node = LayerNode.make(layer, [Session.node, SessionStatus.node, Agent.node, EventV2Bridge.node])

export * as SessionLoop from "./loop"
