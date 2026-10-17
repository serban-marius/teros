/**
 * Platform default provider — an operator-configured OpenAI-compatible upstream
 * (e.g. NaN Builders) that every user and agent runs on by default.
 *
 * Configured by the system secret `.secrets/system/default-provider.json`
 * (`DefaultProviderSecret`). When present:
 *   - every user gets a managed `openai-compatible` provider record
 *     (`managedBy: 'platform-default'`) — at signup, and at boot for existing
 *     users (`syncPlatformDefaultProviders`);
 *   - that record takes the user's default slot from the built-in `teros`
 *     provider (once), never from a provider the user brought themselves;
 *   - the API key is resolved from the secret at call time
 *     (`ProviderService.resolveProviderSecrets`), never stored per user;
 *   - the `system` user (internal services: channel naming, agent profiles)
 *     gets the same record when it has no provider of its own.
 * When absent, nothing changes: `teros` stays the default and managed records
 * left over from an earlier configuration are disabled at the next boot.
 */

import type { Db } from "mongodb"
import type { DefaultProviderModelSecret, DefaultProviderSecret } from "../secrets/types"
import type { ProviderModel, ProviderService } from "./provider-service"

export const PLATFORM_DEFAULT_MANAGED_BY = "platform-default"

/** User id of the internal-services provider owner (see init-system-provider.ts). */
export const SYSTEM_USER_ID = "system"

export interface PlatformDefaultProvider {
  displayName: string
  baseUrl: string
  apiKey?: string
  customHeaders?: Record<string, string>
  /** Chat models, default model first. */
  models: ProviderModel[]
  defaultModelId: string
  /** Model internal services use (channel naming, agent profiles). */
  systemModelId: string
  /** Extra request-body fields for internal-service calls only. */
  systemExtraBody?: Record<string, unknown>
}

/** Same id scheme as user-added openai-compatible providers (provider-service). */
export function openAICompatibleModelId(modelName: string): string {
  return `openai-compatible-${modelName.replace(/[^a-zA-Z0-9]/g, "-")}`
}

function toProviderModel(entry: string | DefaultProviderModelSecret): ProviderModel {
  const m = typeof entry === "string" ? { id: entry } : entry
  const thinking = m.thinking ?? false
  return {
    modelId: openAICompatibleModelId(m.id),
    modelString: m.id,
    capabilities: {
      streaming: true,
      tools: m.tools ?? true,
      vision: m.vision ?? false,
      thinking,
      reasoningLevel: thinking ? 2 : 1,
    },
    context: {
      maxTokens: m.contextTokens ?? 128000,
      maxOutputTokens: m.maxOutputTokens ?? 32768,
    },
  }
}

/**
 * Normalize a `default-provider` secret. Returns null when it is absent or
 * unusable (missing baseUrl/defaultModel), so callers fall back to `teros`.
 */
export function parsePlatformDefaultProvider(
  raw: DefaultProviderSecret | undefined,
): PlatformDefaultProvider | null {
  if (!raw?.baseUrl || !raw.defaultModel) return null

  const entries = raw.models?.length ? raw.models : [raw.defaultModel]
  const models = entries.map(toProviderModel)
  const defaultModelId = openAICompatibleModelId(raw.defaultModel)
  if (!models.some((m) => m.modelId === defaultModelId)) {
    models.unshift(toProviderModel(raw.defaultModel))
  }
  // Default model first: resolvers and pickers that take models[0] agree with defaultModelId.
  models.sort((a, b) => Number(b.modelId === defaultModelId) - Number(a.modelId === defaultModelId))

  const systemModelId = raw.systemModel ? openAICompatibleModelId(raw.systemModel) : defaultModelId
  if (!models.some((m) => m.modelId === systemModelId)) {
    models.push(toProviderModel(raw.systemModel as string))
  }

  return {
    displayName: raw.displayName || "Default",
    baseUrl: raw.baseUrl,
    apiKey: raw.apiKey || undefined,
    customHeaders: raw.customHeaders,
    models,
    defaultModelId,
    systemModelId,
    systemExtraBody: raw.systemExtraBody,
  }
}

/** Read the platform default from the loaded system secrets (null if unset or not loaded). */
export function readPlatformDefaultProvider(source: {
  system(name: "default-provider"): DefaultProviderSecret | undefined
}): PlatformDefaultProvider | null {
  try {
    return parsePlatformDefaultProvider(source.system("default-provider"))
  } catch {
    // Secrets not loaded (scripts, tests): behave as unconfigured.
    return null
  }
}

export function isPlatformDefaultRecord(provider: { managedBy?: string }): boolean {
  return provider.managedBy === PLATFORM_DEFAULT_MANAGED_BY
}

/**
 * Boot-time reconcile (idempotent, every boot): provision or refresh the
 * managed record for every user and for the `system` user, or disable the
 * managed records when the platform default is no longer configured.
 * A boot sync rather than a migration so that configuring the secret later,
 * or changing its models, reaches every existing account.
 */
export async function syncPlatformDefaultProviders(
  db: Db,
  providerService: ProviderService,
): Promise<{ provisioned: number; failed: number; disabled: number }> {
  if (!providerService.getPlatformDefaultProvider()) {
    const disabled = await providerService.disablePlatformDefaultProviders()
    return { provisioned: 0, failed: 0, disabled }
  }

  const users = await db
    .collection<{ userId: string }>("users")
    .find({}, { projection: { userId: 1, _id: 0 } })
    .toArray()
  const userIds = users.map((u) => u.userId).filter(Boolean)

  let provisioned = 0
  let failed = 0
  for (const userId of userIds) {
    try {
      if (await providerService.ensurePlatformDefaultProvider(userId)) provisioned++
    } catch (error) {
      failed++
      console.error(`[PlatformDefault] Failed to provision user ${userId}:`, error)
    }
  }

  try {
    await providerService.ensureSystemPlatformDefaultProvider()
  } catch (error) {
    failed++
    console.error("[PlatformDefault] Failed to provision the system provider:", error)
  }

  return { provisioned, failed, disabled: 0 }
}
