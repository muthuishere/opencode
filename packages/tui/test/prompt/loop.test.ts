import { describe, expect, test } from "bun:test"
import { parseDuration, parseLoop } from "../../src/component/prompt/loop"

describe("parseDuration", () => {
  test("parses single-unit durations", () => {
    expect(parseDuration("30s")).toBe(30_000)
    expect(parseDuration("5m")).toBe(5 * 60_000)
    expect(parseDuration("1h")).toBe(60 * 60_000)
    expect(parseDuration("90s")).toBe(90_000)
  })

  test("parses compound durations", () => {
    expect(parseDuration("2m30s")).toBe(150_000)
    expect(parseDuration("1h30m")).toBe(90 * 60_000)
  })

  test("rejects non-durations", () => {
    expect(parseDuration("")).toBeUndefined()
    expect(parseDuration("fix")).toBeUndefined()
    expect(parseDuration("5")).toBeUndefined()
    expect(parseDuration("5x")).toBeUndefined()
    expect(parseDuration("m5")).toBeUndefined()
    expect(parseDuration("0s")).toBeUndefined()
    expect(parseDuration("5min")).toBeUndefined()
  })
})

describe("parseLoop", () => {
  test("empty → status", () => {
    expect(parseLoop("")).toEqual({ kind: "status" })
    expect(parseLoop("   ")).toEqual({ kind: "status" })
  })

  test("stop aliases", () => {
    expect(parseLoop("stop")).toEqual({ kind: "stop" })
    expect(parseLoop("off")).toEqual({ kind: "stop" })
    expect(parseLoop(" STOP ")).toEqual({ kind: "stop" })
  })

  test("interval mode", () => {
    expect(parseLoop("5m check the build")).toEqual({
      kind: "start",
      intervalMs: 5 * 60_000,
      intervalLabel: "5m",
      body: "check the build",
    })
    expect(parseLoop("2m30s /review")).toEqual({
      kind: "start",
      intervalMs: 150_000,
      intervalLabel: "2m30s",
      body: "/review",
    })
  })

  test("self-paced mode (no interval)", () => {
    expect(parseLoop("fix all the type errors")).toEqual({
      kind: "start",
      body: "fix all the type errors",
    })
    expect(parseLoop("/review")).toEqual({ kind: "start", body: "/review" })
  })

  test("first token that is not a duration is part of the body", () => {
    expect(parseLoop("fix this")).toEqual({ kind: "start", body: "fix this" })
    // a word starting with a number but not a duration
    expect(parseLoop("5x do something")).toEqual({ kind: "start", body: "5x do something" })
  })

  test("bare interval with no body → status", () => {
    expect(parseLoop("5m")).toEqual({ kind: "status" })
  })
})
