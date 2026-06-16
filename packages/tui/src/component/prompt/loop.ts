/**
 * `/loop` parsing helpers for the main TUI prompt.
 *
 * The loop itself runs SERVER-SIDE (the loop engine — see
 * `packages/opencode/specs/loop-engine.md`). The client is a thin shell: it
 * parses `/loop [interval] <prompt | /command>`, `/loop stop`, and bare `/loop`
 * (status), then calls the engine over the SDK. There are no client-side
 * timers, schedulers, or idle effects here anymore.
 */

export type LoopParse =
  | { kind: "stop" }
  | { kind: "status" }
  | { kind: "start"; intervalMs?: number; intervalLabel?: string; body: string }

const DURATION_RE = /^(?:\d+h)?(?:\d+m)?(?:\d+s)?$/
const DURATION_PART_RE = /(\d+)(h|m|s)/g

/**
 * Parse a duration token like `30s`, `5m`, `1h`, `90s`, `2m30s` into
 * milliseconds. Returns undefined when the token is not a pure duration (so the
 * caller can treat it as the start of the prompt body instead).
 */
export function parseDuration(token: string): number | undefined {
  if (!token) return undefined
  // Must be only digit+unit groups, at least one group, no stray characters.
  if (!DURATION_RE.test(token)) return undefined
  let ms = 0
  let matched = false
  DURATION_PART_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = DURATION_PART_RE.exec(token)) !== null) {
    matched = true
    const value = Number(match[1])
    const unit = match[2]
    if (unit === "h") ms += value * 60 * 60 * 1000
    else if (unit === "m") ms += value * 60 * 1000
    else ms += value * 1000
  }
  if (!matched || ms <= 0) return undefined
  return ms
}

function formatInterval(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", seconds ? `${seconds}s` : ""].join("") || "0s"
}

/**
 * Parse the text after the leading `/loop`. `rest` is everything following the
 * command word (the command word itself, `/loop`, is detected by the caller).
 */
export function parseLoop(rest: string): LoopParse {
  const trimmed = rest.trim()
  if (trimmed === "") return { kind: "status" }

  const lowered = trimmed.toLowerCase()
  if (lowered === "stop" || lowered === "off") return { kind: "stop" }

  // First token may be a duration → interval mode.
  const firstSpace = trimmed.search(/\s/)
  if (firstSpace !== -1) {
    const firstToken = trimmed.slice(0, firstSpace)
    const intervalMs = parseDuration(firstToken)
    if (intervalMs !== undefined) {
      const body = trimmed.slice(firstSpace + 1).trim()
      if (body === "") return { kind: "status" }
      return { kind: "start", intervalMs, intervalLabel: formatInterval(intervalMs), body }
    }
  } else {
    // Single token that is itself a duration (e.g. `/loop 5m`) has no body.
    if (parseDuration(trimmed) !== undefined) return { kind: "status" }
  }

  return { kind: "start", body: trimmed }
}
