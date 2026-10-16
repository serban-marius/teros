/**
 * ComputerApi — Typed client for the computer domain (an agent's own Linux
 * desktop, mca.teros.computer).
 *
 * computer.open ensures the agent's computer exists, starts it, and returns a
 * short-lived signed live-view URL to embed in an iframe.
 */

import type { Transport } from './transport/types'

export interface OpenComputerResult {
  appId: string
  appName: string
  agentId?: string
  /** Live view (noVNC page served through the backend proxy). */
  viewUrl: string
  /** The URL must be loaded / reconnected before this; reopen to refresh. */
  expiresAt: string
}

export class ComputerApi {
  constructor(private readonly transport: Transport) {}

  /** Open an agent's computer (created on first use), or a specific computer app. */
  open(target: { agentId?: string; appId?: string; workspaceId?: string }): Promise<OpenComputerResult> {
    return this.transport.request<OpenComputerResult>('computer.open', target)
  }
}
