/**
 * Agent computers — one instance per agent (availability.perAgent) and the
 * computer.open action (real MongoDB, throwaway database).
 *
 * - ensurePerAgentApp: creates the agent's own app (App.forAgentId), grants it
 *   to that agent only, is idempotent, and gives two agents two computers.
 * - ensureProvisionedApps: per-agent system MCAs are provisioned per agent and
 *   never collapsed by the per-owner duplicate repair.
 * - computer.open: workspace / superagent access checks, signed view URL.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import { createOpenComputerHandler } from "../../src/handlers/domains/computer/open"
import { ComputerViewService } from "../../src/services/computer-view-service"
import { McaService } from "../../src/services/mca-service"

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017"
const DB_NAME = `teros_computer_test_${Date.now()}`
const MCA = "mca.teros.computer"
const WS = "work_aaaaaaaaaaaaaaaa"
const OWNER = "user_owner"

let client: MongoClient
let db: Db
let mcaService: McaService

async function seedAgent(
  agentId: string,
  name: string,
  workspaceId: string | null = WS,
  ownerId = OWNER,
) {
  await db.collection("agents").insertOne({ agentId, name, workspaceId, ownerId, coreId: "agent" })
}

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
  mcaService = new McaService(db)
  await db.collection("mca_catalog").insertOne({
    mcaId: MCA,
    name: "Computer",
    status: "active",
    availability: {
      enabled: true,
      multi: true,
      system: true,
      hidden: false,
      role: "user",
      perAgent: true,
    },
    runtime: {
      transport: "http",
      containerMode: "per-app",
      appVolume: { containerPath: "/home/teros" },
    },
  })
  await db
    .collection("workspaces")
    .insertOne({ workspaceId: WS, ownerId: OWNER, status: "active", name: "W" })
  await db
    .collection("users")
    .insertOne({ userId: OWNER, role: "user", profile: { displayName: "Owner" } })
})

describe("ensurePerAgentApp", () => {
  it("creates the agent’s own computer, granted to that agent only", async () => {
    await seedAgent("agent_a", "Alice Bot")
    const app = await mcaService.ensurePerAgentApp("agent_a", MCA, WS)
    expect(app).toMatchObject({
      mcaId: MCA,
      ownerId: WS,
      forAgentId: "agent_a",
      name: "computer-alice-bot",
      toolExposure: "direct",
    })
    const grants = await db.collection("agent_app_access").find({ appId: app.appId }).toArray()
    expect(grants.map((g) => g.agentId)).toEqual(["agent_a"])
  })

  it("is idempotent and gives each agent its own computer", async () => {
    await seedAgent("agent_a", "Alice")
    await seedAgent("agent_b", "Bob")
    const a1 = await mcaService.ensurePerAgentApp("agent_a", MCA, WS)
    const a2 = await mcaService.ensurePerAgentApp("agent_a", MCA, WS)
    const b = await mcaService.ensurePerAgentApp("agent_b", MCA, WS)
    expect(a2.appId).toBe(a1.appId)
    expect(b.appId).not.toBe(a1.appId)
    expect(await db.collection("apps").countDocuments({ mcaId: MCA })).toBe(2)
  })

  it("refuses MCAs that are not per-agent", async () => {
    await db.collection("mca_catalog").insertOne({
      mcaId: "mca.teros.bash",
      status: "active",
      availability: { enabled: true, multi: false, system: true, hidden: false, role: "user" },
    })
    await expect(mcaService.ensurePerAgentApp("agent_a", "mca.teros.bash", WS)).rejects.toThrow(
      "not a per-agent MCA",
    )
  })
})

describe("ensureProvisionedApps with a per-agent system MCA", () => {
  it("provisions one computer per agent and keeps them (no duplicate repair)", async () => {
    await seedAgent("agent_a", "Alice")
    await seedAgent("agent_b", "Bob")
    await mcaService.ensureProvisionedApps("agent_a")
    await mcaService.ensureProvisionedApps("agent_b")
    await mcaService.ensureProvisionedApps("agent_a")
    const apps = await db.collection("apps").find({ mcaId: MCA }).toArray()
    expect(apps.map((a) => a.forAgentId).sort()).toEqual(["agent_a", "agent_b"])
  })
})

describe("computer.open", () => {
  const view = new ComputerViewService({} as never, "secret")
  const warmed: string[] = []
  const open = () =>
    createOpenComputerHandler({
      db,
      mcaService,
      computerViewService: view,
      warmUp: async (appId) => warmed.push(appId),
      publicBaseUrl: "https://api.teros.test/",
    })

  it("returns a signed live-view URL for a workspace member and warms the computer up", async () => {
    await seedAgent("agent_a", "Alice")
    const res = await open()({ userId: OWNER, sessionId: "s" } as never, { agentId: "agent_a" })
    expect(res.viewUrl).toMatch(/^https:\/\/api\.teros\.test\/computer\/[\w-]+\.[\w-]+\/$/)
    const ticket = res.viewUrl.split("/")[4]
    expect(view.verifyTicket(ticket)).toMatchObject({
      userId: OWNER,
      appId: res.appId,
      userName: "Owner",
    })
    expect(warmed).toContain(res.appId)
  })

  it("refuses users outside the agent’s workspace", async () => {
    await seedAgent("agent_a", "Alice")
    await expect(
      open()({ userId: "user_stranger" } as never, { agentId: "agent_a" }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_WORKSPACE",
    })
    expect(await db.collection("apps").countDocuments({ mcaId: MCA })).toBe(0)
  })

  it("a superagent’s computer opens only for its owner", async () => {
    await seedAgent("agent_super", "Super", null, OWNER)
    await db.collection("workspace_members").insertOne({ workspaceId: WS, userId: "user_member" })
    await expect(
      open()({ userId: "user_member" } as never, { agentId: "agent_super", workspaceId: WS }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_AGENT" })
    const res = await open()({ userId: OWNER } as never, {
      agentId: "agent_super",
      workspaceId: WS,
    })
    expect(res.agentId).toBe("agent_super")
  })

  it("opens a computer by app name in a workspace (tool cards carry the tool name, not the appId)", async () => {
    await seedAgent("agent_a", "Alice")
    const app = await mcaService.ensurePerAgentApp("agent_a", MCA, WS)
    const res = await open()({ userId: OWNER } as never, { appName: app.name, workspaceId: WS })
    expect(res.appId).toBe(app.appId)
    await expect(
      open()({ userId: "user_stranger" } as never, { appName: app.name, workspaceId: WS }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_WORKSPACE" })
    await expect(
      open()({ userId: OWNER } as never, { appName: "nope", workspaceId: WS }),
    ).rejects.toMatchObject({
      code: "COMPUTER_NOT_FOUND",
    })
  })

  it("opens an existing computer by appId and rejects other apps", async () => {
    await seedAgent("agent_a", "Alice")
    const app = await mcaService.ensurePerAgentApp("agent_a", MCA, WS)
    const res = await open()({ userId: OWNER } as never, { appId: app.appId })
    expect(res).toMatchObject({ appId: app.appId, agentId: "agent_a" })
    await db
      .collection("apps")
      .insertOne({ appId: "app_other", mcaId: "mca.teros.bash", ownerId: WS, name: "bash" })
    await expect(open()({ userId: OWNER } as never, { appId: "app_other" })).rejects.toMatchObject({
      code: "COMPUTER_NOT_FOUND",
    })
  })
})
