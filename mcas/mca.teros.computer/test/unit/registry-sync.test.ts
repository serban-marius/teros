/**
 * registry-sync — tools.json ↔ buildTools().
 *
 * The LLM reads tools.json, not the TS source: this test fails when the two
 * drift (a tool missing, a description or schema edited on one side only).
 * Regenerate tools.json from buildTools() after changing a tool.
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { buildTools, type ComputerRuntime } from "../../src/tools"

const ROOT = resolve(import.meta.dir, "../..")
const toolsJson = JSON.parse(readFileSync(`${ROOT}/tools.json`, "utf8"))
const TOOLS = buildTools({} as ComputerRuntime)

describe("registry-sync — tools.json ↔ buildTools()", () => {
  it("same tool names", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(
      toolsJson.tools.map((t: { name: string }) => t.name).sort(),
    )
  })

  it("mcaId is mca.teros.computer", () => {
    expect(toolsJson.mcaId).toBe("mca.teros.computer")
  })

  it.each(
    TOOLS.map((t) => [t.name] as const),
  )("%s: description, schema and annotations match", (name) => {
    const src = TOOLS.find((t) => t.name === name)
    const json = toolsJson.tools.find((t: { name: string }) => t.name === name)
    expect(json.description).toBe(src?.description)
    expect(json.inputSchema).toEqual(src?.inputSchema)
    expect(json.annotations ?? null).toEqual(src?.config.annotations ?? null)
  })

  it("look-only tools are read-only (no permission prompt), input tools are not", () => {
    const readOnly = TOOLS.filter((t) => t.config.annotations?.readOnlyHint)
      .map((t) => t.name)
      .sort()
    expect(readOnly).toEqual(["-health-check", "control-status", "get-state", "screenshot", "wait"])
  })
})
