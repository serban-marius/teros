/**
 * Migration 20261017_001: agents' own app instances created before
 * `sandboxedHint` get their sandboxed tools allowed, without overriding what
 * the user chose (real MongoDB, throwaway database).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import { allowSandboxedToolsOnAgentApps } from "../../src/migrations/20261017_001_allow_sandboxed_tools_on_agent_apps"

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017"
const DB_NAME = `teros_sandboxed_migration_test_${Date.now()}`
const TOOLS = [
  { name: "get-state", annotations: { readOnlyHint: true } },
  { name: "click", annotations: { sandboxedHint: true } },
  { name: "type-text", annotations: { sandboxedHint: true } },
  { name: "run-command" },
]
const loadTools = async () => TOOLS

let client: MongoClient
let db: Db

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 3000 })
  await client.connect()
  db = client.db(DB_NAME)
})

afterAll(async () => {
  await db.dropDatabase()
  await client.close()
})

beforeEach(async () => {
  await db.dropDatabase()
})

const app = (appId: string, extra: Record<string, unknown>) =>
  db.collection("apps").insertOne({ appId, mcaId: "mca.teros.computer", ...extra })
const permsOf = async (appId: string) =>
  (await db.collection("apps").findOne({ appId }))?.permissions

describe("allowSandboxedToolsOnAgentApps", () => {
  it("allows sandboxed tools still at ask on an agent's own app; run-command keeps asking", async () => {
    await app("app_mine", {
      forAgentId: "agent_a",
      permissions: {
        defaultPermission: "ask",
        tools: { "get-state": "allow", click: "ask", "run-command": "ask" },
      },
    })
    expect(await allowSandboxedToolsOnAgentApps(db, loadTools)).toEqual({ updated: 1, skipped: 0 })
    expect(await permsOf("app_mine")).toEqual({
      defaultPermission: "ask",
      tools: { "get-state": "allow", click: "allow", "type-text": "allow", "run-command": "ask" },
    })
    // Idempotent.
    expect(await allowSandboxedToolsOnAgentApps(db, loadTools)).toEqual({ updated: 0, skipped: 1 })
  })

  it("keeps the user's choices: forbid pins, app-wide defaults, shared instances", async () => {
    const pinned = { defaultPermission: "ask", tools: { click: "forbid", "type-text": "allow" } }
    const lockedDown = { defaultPermission: "forbid", tools: { click: "ask" } }
    const shared = { defaultPermission: "ask", tools: { click: "ask" } }
    await app("app_pinned", { forAgentId: "agent_a", permissions: pinned })
    await app("app_locked", { forAgentId: "agent_b", permissions: lockedDown })
    await app("app_shared", { permissions: shared })
    expect(await allowSandboxedToolsOnAgentApps(db, loadTools)).toEqual({ updated: 0, skipped: 2 })
    expect(await permsOf("app_pinned")).toEqual(pinned)
    expect(await permsOf("app_locked")).toEqual(lockedDown)
    expect(await permsOf("app_shared")).toEqual(shared)
  })
})
