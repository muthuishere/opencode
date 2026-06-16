import * as Tool from "./tool"
import { SessionLoop } from "@/session/loop"
import { InstanceRef } from "@/effect/instance-ref"
import { Effect, Schema } from "effect"

// The loop engine depends on SessionPrompt, which depends on the ToolRegistry.
// Adding SessionLoop to the registry layer would create a layer cycle, so these
// tools reach the engine across the AppRuntime boundary instead (SessionLoop is
// wired into AppLayer). app-runtime is imported dynamically to avoid a value
// import cycle (registry -> loop tool -> app-runtime -> registry). The current
// InstanceRef is forwarded so the engine resolves the same per-directory loop
// registry the HTTP handlers use.
const runEngine = <A>(fn: (engine: SessionLoop.Interface) => Effect.Effect<A>): Effect.Effect<A> =>
  Effect.gen(function* () {
    const ctx = yield* InstanceRef
    const { AppRuntime } = yield* Effect.promise(() => import("@/effect/app-runtime"))
    return yield* Effect.promise(() =>
      AppRuntime.runPromise(
        SessionLoop.Service.use(fn).pipe(Effect.provideService(InstanceRef, ctx)),
      ),
    )
  })

const LOOP_DESCRIPTION = [
  "Start a recurring background loop that re-runs a prompt on a schedule.",
  "Use this when the user says things like 'every N minutes', 'keep checking', 'on a loop', 'in the background', or 'as a bg agent'.",
  "Each iteration runs in a persistent background subagent session (it remembers prior iterations) and posts a one-line notification to this session — it never takes over the conversation.",
  "Provide `interval` (e.g. '30s', '2m', '1h', '2m30s') to run on a timer; omit it to re-run as soon as the previous iteration finishes (self-paced).",
  "The loop runs until stopped with loop_stop. Returns immediately after scheduling.",
].join(" ")

export const LoopParameters = Schema.Struct({
  prompt: Schema.String.annotate({ description: "The prompt the background subagent re-runs each iteration" }),
  interval: Schema.optional(Schema.String).annotate({
    description: "How often to run, e.g. '30s', '2m', '1h', '2m30s'. Omit for self-paced (run after each iteration completes).",
  }),
  agent: Schema.optional(Schema.String).annotate({
    description: "Optional subagent type for the background session. Defaults to the general subagent.",
  }),
})

export const LoopTool = Tool.define(
  "loop",
  Effect.succeed({
    description: LOOP_DESCRIPTION,
    parameters: LoopParameters,
    execute: (params: Schema.Schema.Type<typeof LoopParameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const result = yield* runEngine((engine) =>
          engine.start({
            parentSessionID: ctx.sessionID,
            prompt: params.prompt,
            interval: params.interval,
            agent: params.agent,
          }),
        )
        const intervalDesc = result.mode === "interval" ? `every ${params.interval}` : "self-paced"
        return {
          title: `loop ${result.loopID.slice(-4)}`,
          metadata: { loopID: result.loopID, bgSessionID: result.bgSessionID, mode: result.mode },
          output: [
            `Started loop ${result.loopID} (${intervalDesc}).`,
            `Background session: ${result.bgSessionID}.`,
            `It runs until you stop it with loop_stop.`,
          ].join("\n"),
        }
      }).pipe(Effect.orDie),
  }),
)

export const LoopStopParameters = Schema.Struct({
  loopID: Schema.optional(Schema.String).annotate({
    description: "The loop to stop. Omit to stop all loops in this session.",
  }),
})

export const LoopStopTool = Tool.define(
  "loop_stop",
  Effect.succeed({
    description:
      "Stop a running loop in this session. Pass loopID to stop one loop, or omit it to stop all loops in this session.",
    parameters: LoopStopParameters,
    execute: (params: Schema.Schema.Type<typeof LoopStopParameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const result = yield* runEngine((engine) =>
          engine.stop({ parentSessionID: ctx.sessionID, loopID: params.loopID }),
        )
        return {
          title: `stopped ${result.stopped} loop(s)`,
          metadata: { stopped: result.stopped },
          output: result.stopped === 0 ? "No matching loops were running." : `Stopped ${result.stopped} loop(s).`,
        }
      }).pipe(Effect.orDie),
  }),
)

export const LoopListParameters = Schema.Struct({})

export const LoopListTool = Tool.define(
  "loop_list",
  Effect.succeed({
    description: "List the active loops in this session, including their prompt, interval, mode, and running state.",
    parameters: LoopListParameters,
    execute: (_params: Schema.Schema.Type<typeof LoopListParameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const loops = yield* runEngine((engine) => engine.list({ parentSessionID: ctx.sessionID }))
        if (loops.length === 0) {
          return { title: "no active loops", metadata: { count: 0 }, output: "No active loops in this session." }
        }
        const output = loops
          .map((loop) => {
            const cadence = loop.mode === "interval" ? `every ${loop.interval}` : "self-paced"
            const running = loop.running ? "running" : "idle"
            return `- ${loop.loopID} (${cadence}, ${running}): ${loop.prompt}`
          })
          .join("\n")
        return { title: `${loops.length} active loop(s)`, metadata: { count: loops.length }, output }
      }).pipe(Effect.orDie),
  }),
)
