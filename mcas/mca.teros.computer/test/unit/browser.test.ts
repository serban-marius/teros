import { describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromiumArgs, repairProfile } from "../../src/browser"

describe("repairProfile", () => {
  it("drops the singleton lock of a killed container and marks the exit clean", async () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-"))
    mkdirSync(join(dir, "Default"))
    for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"])
      writeFileSync(join(dir, f), "old-host")
    writeFileSync(
      join(dir, "Default", "Preferences"),
      JSON.stringify({ profile: { exit_type: "Crashed" }, keep: 1 }),
    )
    await repairProfile(dir)
    expect(existsSync(join(dir, "SingletonLock"))).toBe(false)
    const prefs = JSON.parse(readFileSync(join(dir, "Default", "Preferences"), "utf8"))
    expect(prefs.profile).toMatchObject({ exit_type: "Normal", exited_cleanly: true })
    expect(prefs.keep).toBe(1)
  })

  it("tolerates a fresh or corrupt profile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-"))
    await repairProfile(dir)
    mkdirSync(join(dir, "Default"))
    writeFileSync(join(dir, "Default", "Preferences"), "{not json")
    await expect(repairProfile(dir)).resolves.toBeUndefined()
  })
})

describe("chromiumArgs", () => {
  it("looks like a person’s browser: no automation switches, persistent profile, CDP on loopback", () => {
    const args = chromiumArgs("https://example.com")
    expect(args).toContain("--password-store=basic")
    expect(args).toContain("--remote-debugging-address=127.0.0.1")
    expect(args.some((a) => a.startsWith("--user-data-dir="))).toBe(true)
    expect(args.some((a) => /enable-automation|headless/.test(a))).toBe(false)
    expect(args.at(-1)).toBe("https://example.com")
  })
})
