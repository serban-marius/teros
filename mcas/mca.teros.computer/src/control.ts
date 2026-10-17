import { ComputerError } from "./errors"

export type ControlHolder = "agent" | "human"

export interface ControlStatus {
  holder: ControlHolder
  since: string
  /** Teros user id of the human in control (when holder = human). */
  userId?: string
  displayName?: string
}

/**
 * Who drives the desktop. The agent by default; a human takes over from the
 * live view (e.g. to log into a site) and hands back when done.
 *
 * Enforced on both sides:
 *   - `applyViewerInput(true|false)` flips Xvnc's AcceptPointerEvents /
 *     AcceptKeyEvents / AcceptCutText, so viewers are physically view-only
 *     while the agent drives (a modified client can't bypass it).
 *   - agent input tools call `assertAgentMayAct()` and get `human_has_control`
 *     while a human holds the lease. Looking (state, screenshot) stays allowed.
 * The latest take-over wins. The lease resets to the agent on container start.
 */
export class ControlLease {
  private status: ControlStatus = { holder: "agent", since: new Date().toISOString() }

  constructor(private readonly applyViewerInput: (enabled: boolean) => Promise<void>) {}

  get(): ControlStatus {
    return { ...this.status }
  }

  async takeOver(userId: string, displayName?: string): Promise<ControlStatus> {
    await this.applyViewerInput(true)
    this.status = { holder: "human", since: new Date().toISOString(), userId, displayName }
    return this.get()
  }

  async handBack(): Promise<ControlStatus> {
    await this.applyViewerInput(false)
    this.status = { holder: "agent", since: new Date().toISOString() }
    return this.get()
  }

  assertAgentMayAct(): void {
    if (this.status.holder === "human") {
      const who = this.status.displayName ? ` (${this.status.displayName})` : ""
      throw new ComputerError(
        "human_has_control",
        `a person${who} is using this computer since ${this.status.since}. ` +
          "You can still look (get-state, screenshot), but wait for them to hand control back before acting.",
      )
    }
  }
}
