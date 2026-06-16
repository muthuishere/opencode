// Client-side `/loop` parsing for direct interactive mode (`run --interactive`).
//
// `/loop` re-runs a prompt (or another slash command) repeatedly. Scheduling and
// lifecycle now live SERVER-SIDE in the loop engine -- each loop runs as a
// background subagent that never intercepts the foreground session. This module
// is a THIN CLIENT: it only parses `/loop ...` input and the caller maps the
// parsed result onto the SDK engine calls (`session.loop` / `session.loopStop` /
// `session.loopList`).
//
//   /loop 5m check the build and fix failures   # run every 5 minutes (interval)
//   /loop fix all the type errors               # no interval = self-paced
//   /loop 2m /review                            # body passed verbatim to the bg subagent
//   /loop                                       # status (list active loops)
//   /loop stop                                  # stop all loops in the session
//
// The body is passed through to the engine VERBATIM -- if it is itself a slash
// command (e.g. `/review`), the background subagent receives it; we do not
// resolve commands client-side anymore.

const DURATION_RE = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/

// Parses a duration token like "30s", "5m", "1h", "90s", "2m30s" into ms.
// Returns undefined if the token is not a valid, non-zero duration.
export function parseDuration(token: string): number | undefined {
  const trimmed = token.trim().toLowerCase()
  if (!trimmed) {
    return undefined
  }

  const match = DURATION_RE.exec(trimmed)
  if (!match) {
    return undefined
  }

  const hours = Number(match[1] ?? 0)
  const minutes = Number(match[2] ?? 0)
  const seconds = Number(match[3] ?? 0)
  const total = ((hours * 60 + minutes) * 60 + seconds) * 1000
  return total > 0 ? total : undefined
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`)
  return parts.join("")
}

// Detects a `/loop ...` input. Returns the remainder after `/loop` (trimmed),
// or undefined when the input is not the loop command. `/unloop` is an alias for
// `/loop stop`.
export function loopCommandBody(input: string): string | undefined {
  const trimmed = input.trim()
  const lower = trimmed.toLowerCase()
  if (lower === "/unloop") {
    return "stop"
  }

  if (lower === "/loop") {
    return ""
  }

  if (lower.startsWith("/loop ") || lower.startsWith("/loop\t") || lower.startsWith("/loop\n")) {
    return trimmed.slice("/loop".length).trim()
  }

  return undefined
}

export function isLoopCommand(input: string): boolean {
  return loopCommandBody(input) !== undefined
}

// Splits a body into the body's first whitespace-delimited token and the rest.
function splitFirstToken(body: string): { first: string; rest: string } {
  const trimmed = body.trimStart()
  const match = trimmed.match(/^(\S+)(\s+([\s\S]*))?$/)
  if (!match) {
    return { first: "", rest: "" }
  }

  return { first: match[1], rest: (match[3] ?? "").trim() }
}

export type ParsedLoop =
  // Start a loop: send `prompt` to the engine, with `interval` (the canonical
  // token e.g. "2m") when interval mode, or undefined for self-paced.
  | { type: "start"; prompt: string; interval?: string }
  // Stop all loops in the session.
  | { type: "stop" }
  // List active loops (status).
  | { type: "status" }
  | { type: "error"; message: string }

// Parses a `/loop ...` body (the text after `/loop`) into an engine action.
export function parseLoop(body: string): ParsedLoop {
  const trimmed = body.trim()
  if (trimmed.length === 0) {
    return { type: "status" }
  }

  const lower = trimmed.toLowerCase()
  if (lower === "stop" || lower === "off") {
    return { type: "stop" }
  }

  // The first token may be a duration; if so it is the interval and the rest is
  // the prompt. Otherwise the whole remainder is the prompt (self-paced).
  const { first, rest } = splitFirstToken(trimmed)
  const intervalMs = parseDuration(first)
  const interval = intervalMs !== undefined ? formatDuration(intervalMs) : undefined
  const prompt = intervalMs !== undefined ? rest : trimmed

  if (prompt.trim().length === 0) {
    return { type: "error", message: "usage: /loop [interval] <prompt | /command> · /loop stop" }
  }

  return { type: "start", prompt, interval }
}

// Short, human-friendly form of a loopID for one-line feedback.
export function shortLoopID(loopID: string): string {
  return loopID.length > 8 ? loopID.slice(0, 8) : loopID
}
