/**
 * computer domain — an agent's own Linux computer (mca.teros.computer)
 *
 * Actions:
 *   computer.open → ensure the agent's computer exists (per-agent app),
 *                   warm it up, and return a signed live-view URL
 */

import type { Db } from "mongodb"
import type { ComputerViewService } from "../../../services/computer-view-service"
import type { McaService } from "../../../services/mca-service"
import type { WsRouter } from "../../../ws-framework/WsRouter"
import { createOpenComputerHandler } from "./open"

export interface ComputerDomainDeps {
  db: Db
  mcaService: McaService
  computerViewService: ComputerViewService
  /** Starts the container ahead of the iframe load (best effort). */
  warmUp: (appId: string) => Promise<unknown>
  /** Public base URL of this backend (e.g. https://api.teros.ai). */
  publicBaseUrl: string
}

export function register(router: WsRouter, deps: ComputerDomainDeps): void {
  router.register("computer.open", createOpenComputerHandler(deps))
}
