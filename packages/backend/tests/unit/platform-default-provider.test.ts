/**
 * Platform default provider: an operator-configured OpenAI-compatible upstream
 * (`.secrets/system/default-provider.json`) that every user and agent runs on
 * by default, credential-free for the user.
 *
 * Pins, against the in-memory Mongo:
 *   1. parsing the secret (absent/invalid ⇒ unconfigured; default model first);
 *   2. ProviderService.ensurePlatformDefaultProvider — the managed record and
 *      the default-slot rule (no default / teros ⇒ claim once; BYOK ⇒ never);
 *   3. the key comes from the secret at call time, never from the user record;
 *   4. signup, the boot sync (users + `system`), and the resolver's lazy path;
 *   5. internal services pick the system model and its extra request body.
 */

import { describe, expect, it } from "bun:test"
import { UserService } from "../../src/auth/user-service"
import { createSystemLLMClient } from "../../src/services/internal-llm-service"
import {
  type PlatformDefaultProvider,
  parsePlatformDefaultProvider,
  syncPlatformDefaultProviders,
} from "../../src/services/platform-default-provider"
import { ProviderService } from "../../src/services/provider-service"
import { InMemoryDb } from "./_stripe-test-helpers"

const SECRET = {
  displayName: "NaN Builders",
  baseUrl: "https://api.nan.builders/v1",
  apiKey: "test-platform-key",
  defaultModel: "qwen3.6",
  models: [{ id: "gemma4" }, { id: "qwen3.6", vision: true }],
  systemModel: "qwen3.8-flash",
  systemExtraBody: { chat_template_kwargs: { enable_thinking: false } },
}
const PLATFORM = parsePlatformDefaultProvider(SECRET) as PlatformDefaultProvider
const QWEN = "openai-compatible-qwen3-6"

/** A ProviderService whose platform default can be switched by the test. */
function makeService(db: InMemoryDb, initial: PlatformDefaultProvider | null = PLATFORM) {
  const state = { platform: initial }
  const svc = new ProviderService(db as any, () => state.platform)
  return { svc, state }
}

async function insertProvider(db: InMemoryDb, doc: Record<string, unknown>) {
  await db.collection("user_providers").insertOne({
    displayName: String(doc.providerType),
    models: [{ modelId: "m", modelString: "m", capabilities: {} }],
    priority: 100,
    status: "active",
    createdAt: "t",
    updatedAt: "t",
    ...doc,
  })
}

async function providersOf(db: InMemoryDb, userId: string) {
  return db.collection("user_providers").find({ userId }).toArray()
}

describe("parsePlatformDefaultProvider", () => {
  it("is unconfigured when the secret is absent or lacks baseUrl/defaultModel", () => {
    expect(parsePlatformDefaultProvider(undefined)).toBeNull()
    expect(parsePlatformDefaultProvider({ ...SECRET, baseUrl: "" })).toBeNull()
    expect(parsePlatformDefaultProvider({ ...SECRET, defaultModel: "" })).toBeNull()
  })

  it("puts the default model first and adds the system model when unlisted", () => {
    expect(PLATFORM.defaultModelId).toBe(QWEN)
    expect(PLATFORM.models.map((m) => m.modelString)).toEqual([
      "qwen3.6",
      "gemma4",
      "qwen3.8-flash",
    ])
    expect(PLATFORM.models[0]?.capabilities.vision).toBe(true)
    expect(PLATFORM.models[1]?.capabilities.vision).toBe(false)
    expect(PLATFORM.systemModelId).toBe("openai-compatible-qwen3-8-flash")
  })

  it("defaults the model list to the default model alone", () => {
    const p = parsePlatformDefaultProvider({ ...SECRET, models: undefined, systemModel: undefined })
    expect(p?.models.map((m) => m.modelString)).toEqual(["qwen3.6"])
    expect(p?.systemModelId).toBe(QWEN)
  })
})

describe("ProviderService.ensurePlatformDefaultProvider", () => {
  it("does nothing when no platform default is configured", async () => {
    const db = new InMemoryDb()
    const { svc } = makeService(db, null)

    expect(await svc.ensurePlatformDefaultProvider("user_1")).toBeNull()
    expect(await providersOf(db, "user_1")).toHaveLength(0)
  })

  it("provisions a managed, key-less openai-compatible default for a user with none", async () => {
    const db = new InMemoryDb()
    const { svc } = makeService(db)

    const provider = await svc.ensurePlatformDefaultProvider("user_1")

    expect(provider?.providerType).toBe("openai-compatible")
    expect(provider?.managedBy).toBe("platform-default")
    expect(provider?.displayName).toBe("NaN Builders")
    expect(provider?.isDefault).toBe(true)
    expect(provider?.defaultModelId).toBe(QWEN)
    expect(provider?.config?.baseUrl).toBe(SECRET.baseUrl)
    const [stored] = await providersOf(db, "user_1")
    expect(stored?.isDefault).toBe(true)
    // The platform key is never copied into the user's record.
    expect(stored?.encryptedData).toBeUndefined()
    expect(JSON.stringify(stored)).not.toContain(SECRET.apiKey)
  })

  it("takes the default slot from the built-in teros provider", async () => {
    const db = new InMemoryDb()
    const { svc } = makeService(db)
    await insertProvider(db, {
      providerId: "prov_teros",
      userId: "user_1",
      providerType: "teros",
      isDefault: true,
    })

    const provider = await svc.ensurePlatformDefaultProvider("user_1")

    expect(provider?.isDefault).toBe(true)
    const teros = await db.collection("user_providers").findOne({ providerId: "prov_teros" })
    expect(teros?.isDefault).toBe(false)
  })

  it("never takes the default slot from a provider the user brought", async () => {
    const db = new InMemoryDb()
    const { svc } = makeService(db)
    await insertProvider(db, {
      providerId: "prov_byok",
      userId: "user_1",
      providerType: "anthropic",
      isDefault: true,
    })

    const first = await svc.ensurePlatformDefaultProvider("user_1")
    const again = await svc.ensurePlatformDefaultProvider("user_1")

    expect(first?.isDefault).toBe(false)
    expect(again?.isDefault).toBe(false)
    const byok = await db.collection("user_providers").findOne({ providerId: "prov_byok" })
    expect(byok?.isDefault).toBe(true)
  })

  it("claims teros's slot only once: a user who moves the default back keeps it", async () => {
    const db = new InMemoryDb()
    const { svc } = makeService(db)
    await insertProvider(db, {
      providerId: "prov_teros",
      userId: "user_1",
      providerType: "teros",
      isDefault: true,
    })
    const managed = await svc.ensurePlatformDefaultProvider("user_1")

    // The user makes Teros their default again.
    const coll = db.collection("user_providers")
    await coll.updateOne({ providerId: managed?.providerId }, { $set: { isDefault: false } })
    await coll.updateOne({ providerId: "prov_teros" }, { $set: { isDefault: true } })

    const resynced = await svc.ensurePlatformDefaultProvider("user_1")

    expect(resynced?.isDefault).toBe(false)
    expect((await coll.findOne({ providerId: "prov_teros" }))?.isDefault).toBe(true)
  })

  it("is idempotent and carries configuration changes into the existing record", async () => {
    const db = new InMemoryDb()
    const { svc, state } = makeService(db)
    const first = await svc.ensurePlatformDefaultProvider("user_1")

    state.platform = parsePlatformDefaultProvider({
      ...SECRET,
      displayName: "NaN",
      defaultModel: "gemma4",
    })
    const second = await svc.ensurePlatformDefaultProvider("user_1")

    expect(second?.providerId).toBe(first?.providerId)
    expect(await providersOf(db, "user_1")).toHaveLength(1)
    const [stored] = await providersOf(db, "user_1")
    expect(stored?.displayName).toBe("NaN")
    expect(stored?.defaultModelId).toBe("openai-compatible-gemma4")
    expect(stored?.isDefault).toBe(true)
  })
})

describe("ProviderService.resolveProviderSecrets — platform-held key", () => {
  it("resolves the managed record's key from the platform default, and nothing once unset", async () => {
    const db = new InMemoryDb()
    const { svc, state } = makeService(db)
    const provider = await svc.ensurePlatformDefaultProvider("user_1")

    expect(await svc.resolveProviderSecrets(provider!)).toEqual({ apiKey: SECRET.apiKey })

    state.platform = null
    expect(await svc.resolveProviderSecrets(provider!)).toBeNull()
  })
})

describe("ProviderService.resolveProviderForAgent — agents without an explicit model", () => {
  it("runs a default agent (availableProviders: []) on the platform default model", async () => {
    const db = new InMemoryDb()
    const { svc } = makeService(db)
    await insertProvider(db, {
      providerId: "prov_teros",
      userId: "user_1",
      providerType: "teros",
      isDefault: true,
    })
    await db.collection("agents").insertOne({
      agentId: "agent_vita",
      ownerId: "user_1",
      coreId: "agent",
      availableProviders: [],
    })
    await svc.ensurePlatformDefaultProvider("user_1")

    const resolved = await svc.resolveProviderForAgent("agent_vita")

    expect(resolved?.provider.managedBy).toBe("platform-default")
    expect(resolved?.model?.modelString).toBe("qwen3.6")
    expect(resolved?.secrets.apiKey).toBe(SECRET.apiKey)
  })

  it("provisions the platform default lazily for a user with no provider at all", async () => {
    const db = new InMemoryDb()
    const { svc } = makeService(db)
    await db.collection("agents").insertOne({
      agentId: "agent_new",
      ownerId: "user_seeded",
      coreId: "agent",
      availableProviders: [],
    })

    const resolved = await svc.resolveProviderForAgent("agent_new")

    expect(resolved?.model?.modelString).toBe("qwen3.6")
    expect(await providersOf(db, "user_seeded")).toHaveLength(1)
  })
})

describe("signup and boot sync", () => {
  it("createUser gives a new user Teros plus the platform default, which holds the default slot", async () => {
    const db = new InMemoryDb()
    const userService = new UserService(db as any)
    userService.setProviderService(makeService(db).svc)

    const user = await userService.createUser({ email: "new@example.com", displayName: "New" })

    const providers = await providersOf(db, user.userId)
    expect(providers.map((p) => p.providerType).sort()).toEqual(["openai-compatible", "teros"])
    const defaults = providers.filter((p) => p.isDefault)
    expect(defaults).toHaveLength(1)
    expect(defaults[0]?.managedBy).toBe("platform-default")
  })

  it("the boot sync provisions every user and the system user", async () => {
    const db = new InMemoryDb()
    const { svc } = makeService(db)
    await db.collection("users").insertOne({ userId: "user_1" })
    await db.collection("users").insertOne({ userId: "user_2" })

    const result = await syncPlatformDefaultProviders(db as any, svc)

    expect(result).toEqual({ provisioned: 2, failed: 0, disabled: 0 })
    for (const userId of ["user_1", "user_2", "system"]) {
      const [p] = await providersOf(db, userId)
      expect(p?.managedBy).toBe("platform-default")
    }
  })

  it("leaves a system user that has its own provider alone", async () => {
    const db = new InMemoryDb()
    const { svc } = makeService(db)
    await insertProvider(db, {
      providerId: "prov_sys",
      userId: "system",
      providerType: "openrouter",
    })

    await syncPlatformDefaultProviders(db as any, svc)

    expect(await providersOf(db, "system")).toHaveLength(1)
  })

  it("disables managed records once the platform default is unconfigured", async () => {
    const db = new InMemoryDb()
    const { svc, state } = makeService(db)
    await db.collection("users").insertOne({ userId: "user_1" })
    await syncPlatformDefaultProviders(db as any, svc)

    state.platform = null
    const result = await syncPlatformDefaultProviders(db as any, svc)

    expect(result.disabled).toBe(2) // user_1 + system
    const [p] = await providersOf(db, "user_1")
    expect(p?.status).toBe("disabled")
    expect(p?.isDefault).toBe(false)
  })
})

describe("createSystemLLMClient — internal services on the platform default", () => {
  it("uses the system model, the platform key and the system request body", async () => {
    const db = new InMemoryDb()
    const { svc } = makeService(db)
    await svc.ensureSystemPlatformDefaultProvider()

    const { client, model, provider } = await createSystemLLMClient(svc, {
      maxTokens: 200,
      preferModel: (models) => models.find((m) => m.modelId.includes("sonnet")),
    })

    expect(provider.managedBy).toBe("platform-default")
    expect(model.modelString).toBe("qwen3.8-flash")
    expect((client as any).extraBody).toEqual(SECRET.systemExtraBody)
    expect((client as any).defaultModel).toBe("qwen3.8-flash")
  })

  it("fails clearly when the system user has no provider", async () => {
    const db = new InMemoryDb()
    const { svc } = makeService(db, null)

    await expect(createSystemLLMClient(svc, { maxTokens: 200 })).rejects.toThrow(
      /No provider configured for system user/,
    )
  })
})
