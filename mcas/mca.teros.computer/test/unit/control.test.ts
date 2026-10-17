import { describe, expect, it } from "bun:test"
import { ControlLease } from "../../src/control"

function lease() {
  const applied: boolean[] = []
  const l = new ControlLease(async (enabled) => {
    applied.push(enabled)
  })
  return { l, applied }
}

describe("ControlLease", () => {
  it("starts with the agent in control", () => {
    const { l } = lease()
    expect(l.get().holder).toBe("agent")
    expect(() => l.assertAgentMayAct()).not.toThrow()
  })

  it("take-over opens viewer input and fences the agent with human_has_control", async () => {
    const { l, applied } = lease()
    const s = await l.takeOver("user_1", "Marius")
    expect(s).toMatchObject({ holder: "human", userId: "user_1", displayName: "Marius" })
    expect(applied).toEqual([true])
    expect(() => l.assertAgentMayAct()).toThrow(/^human_has_control: a person \(Marius\)/)
  })

  it("hand back closes viewer input and lets the agent act again", async () => {
    const { l, applied } = lease()
    await l.takeOver("user_1")
    await l.handBack()
    expect(applied).toEqual([true, false])
    expect(l.get().holder).toBe("agent")
    expect(() => l.assertAgentMayAct()).not.toThrow()
  })

  it("does not flip the lease when the input gate fails (fail closed)", async () => {
    const l = new ControlLease(async () => {
      throw new Error("vncconfig failed")
    })
    await expect(l.takeOver("user_1")).rejects.toThrow("vncconfig failed")
    expect(l.get().holder).toBe("agent")
  })
})
