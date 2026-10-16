/**
 * openai-compatible: the API key is optional (hosted endpoints behind auth
 * such as NaN Builders or vLLM need one; a local LM Studio doesn't). Before,
 * the type was credential-free only: provider.add dropped the key and model
 * resolution never loaded one, so authenticated endpoints could not work.
 */

import { describe, expect, it } from "bun:test"
import { createAddProviderHandler } from "../../src/handlers/domains/provider/add"
import { ProviderService } from "../../src/services/provider-service"
import { InMemoryDb } from "./_stripe-test-helpers"

function serviceWith(stored: Record<string, string> | null) {
  const svc = new ProviderService(new InMemoryDb() as never)
  const asked: string[] = []
  svc.getProviderSecrets = async (_u: string, providerId: string) => {
    asked.push(providerId)
    return stored as never
  }
  return { svc, asked }
}

describe("ProviderService.resolveProviderSecrets", () => {
  const p = (providerType: string) =>
    ({ userId: "u", providerId: `prov_${providerType}`, providerType }) as never

  it("openai-compatible: stored key when there is one, empty secrets when not", async () => {
    expect(
      await serviceWith({ apiKey: "k" }).svc.resolveProviderSecrets(p("openai-compatible")),
    ).toEqual({ apiKey: "k" })
    expect(await serviceWith(null).svc.resolveProviderSecrets(p("openai-compatible"))).toEqual({})
  })

  it("credential-free types never read secrets", async () => {
    const { svc, asked } = serviceWith({ apiKey: "k" })
    expect(await svc.resolveProviderSecrets(p("ollama"))).toEqual({})
    expect(await svc.resolveProviderSecrets(p("teros"))).toEqual({})
    expect(asked).toEqual([])
  })

  it("key-based types still require their secrets", async () => {
    expect(await serviceWith(null).svc.resolveProviderSecrets(p("anthropic"))).toBeNull()
  })
})

describe("provider.add", () => {
  function fakeService() {
    const stored: Array<{ providerId: string; secrets: unknown }> = []
    const svc = {
      addProvider: async (_u: string, d: { providerType: string; displayName: string }) => ({
        providerId: "prov_1",
        providerType: d.providerType,
        displayName: d.displayName,
        status: "active",
        priority: 1,
      }),
      setProviderSecrets: async (_u: string, providerId: string, secrets: unknown) => {
        stored.push({ providerId, secrets })
      },
      testProvider: async () => ({ ok: true }),
    }
    return { svc, stored }
  }

  it("stores the optional key of an openai-compatible provider", async () => {
    const { svc, stored } = fakeService()
    await createAddProviderHandler(svc as never)({ userId: "u" } as never, {
      providerType: "openai-compatible",
      displayName: "NaN",
      config: { baseUrl: "https://llm.test/v1" },
      auth: { apiKey: "sk-test" },
    })
    expect(stored).toEqual([{ providerId: "prov_1", secrets: { apiKey: "sk-test" } }])
  })

  it("keeps ollama credential-free even if a key is sent", async () => {
    const { svc, stored } = fakeService()
    await createAddProviderHandler(svc as never)({ userId: "u" } as never, {
      providerType: "ollama",
      displayName: "Local",
      auth: { apiKey: "ignored" },
    })
    expect(stored).toEqual([])
  })
})
