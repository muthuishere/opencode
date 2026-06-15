// Session-scoped pub/sub: any caller may publish a prompt to a session ID; a
// per-session background worker drains the queue via SessionPrompt and resolves
// the caller's deferred with the result, effectively routing the response back
// to the original source.
//
// One Queue per session → one background worker per session.  The worker is
// started lazily on the first publish and runs until the parent scope closes.
import { Context, Deferred, Effect, Layer, Queue, Scope } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionPrompt, type PromptInput } from "./prompt"
import type { Image } from "@/image/image"
import type { SessionID } from "./schema"

type PendingMessage = {
  input: PromptInput
  deferred: Deferred.Deferred<SessionV1.WithParts, Image.Error>
}

type State = {
  queues: Map<SessionID, Queue.Queue<PendingMessage>>
  /** Sessions for which a background worker has already been forked. */
  started: Set<SessionID>
  scope: Scope.Scope
}

export interface Interface {
  /**
   * Publish a prompt for the given session.  A background worker will pick it
   * up, run it through SessionPrompt, and resolve the returned Deferred with
   * the assistant reply.  Await the Deferred to receive the response.
   */
  readonly publish: (input: PromptInput) => Effect.Effect<Deferred.Deferred<SessionV1.WithParts, Image.Error>>
  /**
   * Explicitly start a background worker for the given session so it is ready
   * before the first publish.  Calling publish already triggers subscribe
   * implicitly; calling subscribe directly is optional.
   */
  readonly subscribe: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPubSub") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionPubSub.state")(function* () {
        const scope = yield* Scope.Scope
        const queues = new Map<SessionID, Queue.Queue<PendingMessage>>()
        const started = new Set<SessionID>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(queues.values(), Queue.shutdown, { concurrency: "unbounded", discard: true })
            queues.clear()
            started.clear()
          }),
        )
        return { queues, started, scope } satisfies State
      }),
    )

    // Drain one message from the queue then loop forever.
    const workerLoop = (queue: Queue.Queue<PendingMessage>): Effect.Effect<never> =>
      Effect.forever(
        Effect.gen(function* () {
          const { input, deferred } = yield* Queue.take(queue)
          const exit = yield* Effect.exit(prompt.prompt(input))
          yield* Deferred.done(deferred, exit).pipe(Effect.ignore)
        }),
      )

    const ensureWorker = Effect.fn("SessionPubSub.ensureWorker")(function* (
      data: State,
      sessionID: SessionID,
      queue: Queue.Queue<PendingMessage>,
    ) {
      if (data.started.has(sessionID)) return
      data.started.add(sessionID)
      yield* workerLoop(queue).pipe(Effect.forkIn(data.scope, { startImmediately: true }))
    })

    const getOrCreateQueue = Effect.fn("SessionPubSub.getOrCreateQueue")(function* (
      data: State,
      sessionID: SessionID,
    ) {
      const existing = data.queues.get(sessionID)
      if (existing) return existing
      const queue = yield* Queue.unbounded<PendingMessage>()
      data.queues.set(sessionID, queue)
      return queue
    })

    const subscribe: Interface["subscribe"] = Effect.fn("SessionPubSub.subscribe")(function* (sessionID) {
      const data = yield* InstanceState.get(state)
      const queue = yield* getOrCreateQueue(data, sessionID)
      yield* ensureWorker(data, sessionID, queue)
    })

    const publish: Interface["publish"] = Effect.fn("SessionPubSub.publish")(function* (input) {
      const data = yield* InstanceState.get(state)
      const queue = yield* getOrCreateQueue(data, input.sessionID)
      yield* ensureWorker(data, input.sessionID, queue)
      const deferred = yield* Deferred.make<SessionV1.WithParts, Image.Error>()
      yield* Queue.offer(queue, { input, deferred })
      return deferred
    })

    return Service.of({ publish, subscribe })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(SessionPrompt.defaultLayer))

export const node = LayerNode.make(layer, [SessionPrompt.node])

export * as SessionPubSub from "./pubsub"
