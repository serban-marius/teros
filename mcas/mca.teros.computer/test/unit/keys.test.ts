import { describe, expect, it } from "bun:test"
import { parseKeySequence, parseModifiers, toXdotoolChord } from "../../src/keys"

describe("toXdotoolChord", () => {
  it.each([
    ["Enter", "Return"],
    ["escape", "Escape"],
    ["PageDown", "Next"],
    ["ArrowLeft", "Left"],
    ["ctrl+l", "ctrl+l"],
    ["Control+Shift+T", "ctrl+shift+T"],
    ["cmd+a", "ctrl+a"],
    ["alt+F4", "alt+F4"],
    ["a", "a"],
  ])("%s → %s", (input, expected) => {
    expect(toXdotoolChord(input)).toBe(expected)
  })

  it("rejects unknown modifiers and junk keys", () => {
    expect(() => toXdotoolChord("hyper+a")).toThrow("invalid_argument")
    expect(() => toXdotoolChord("ctrl+$(rm)")).toThrow("invalid_argument")
  })
})

describe("parseKeySequence", () => {
  it("splits chords on whitespace", () => {
    expect(parseKeySequence("ctrl+a  Delete")).toEqual(["ctrl+a", "Delete"])
  })
  it("rejects empty and overly long sequences", () => {
    expect(() => parseKeySequence("  ")).toThrow("invalid_argument")
    expect(() => parseKeySequence(Array(21).fill("a").join(" "))).toThrow("invalid_argument")
  })
})

describe("parseModifiers", () => {
  it("maps aliases", () => {
    expect(parseModifiers("ctrl+shift")).toEqual(["ctrl", "shift"])
    expect(parseModifiers(undefined)).toEqual([])
  })
})
