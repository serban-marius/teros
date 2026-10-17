import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type McaToolAnnotations, McaToolAnnotationsSchema } from "@teros/shared"
import type { Db } from "mongodb"
import type { AppToolPermissions, ToolPermission } from "../types/database.js"
import { isAllowedAtInstall } from "../types/permissions.js"
import type { Migration } from "./types.js"

type ToolDefs = Array<{ name: string; annotations?: McaToolAnnotations }>

async function toolsFromManifest(mcaId: string): Promise<ToolDefs> {
  const { config } = await import("../config.js")
  try {
    const raw = JSON.parse(
      readFileSync(join(config.mca.basePath, mcaId, "tools.json"), "utf-8"),
    ) as {
      tools?: Array<{ name: string; annotations?: unknown }>
    }
    return (raw.tools ?? []).map((t) => {
      const parsed = t.annotations ? McaToolAnnotationsSchema.safeParse(t.annotations) : null
      return { name: t.name, annotations: parsed?.success ? parsed.data : undefined }
    })
  } catch {
    return [] // No tools.json (external/retired MCA) — nothing to change.
  }
}

/**
 * Agents' own app instances (`App.forAgentId`, e.g. their computer) created
 * before `sandboxedHint` existed were seeded with 'ask' for every GUI tool, so
 * a desktop loop asked on every click. Bring them to the new install seed.
 *
 * User intent wins, as in 20260704_002: apps with an app-wide 'allow'/'forbid'
 * default are skipped, and only tools still at 'ask' (or missing) change —
 * 'allow' and 'forbid' pins are kept. Tools without the hint (e.g.
 * run-command) are never touched. Idempotent.
 */
export async function allowSandboxedToolsOnAgentApps(
  db: Db,
  loadTools: (mcaId: string) => Promise<ToolDefs> = toolsFromManifest,
): Promise<{ updated: number; skipped: number }> {
  const apps = db.collection("apps")
  const cache = new Map<string, ToolDefs>()
  let updated = 0
  let skipped = 0

  for await (const app of apps.find({ forAgentId: { $exists: true, $ne: null } })) {
    const permissions = app.permissions as AppToolPermissions | undefined
    if ((permissions?.defaultPermission ?? "ask") !== "ask") {
      skipped++
      continue
    }
    const mcaId = app.mcaId as string
    if (!cache.has(mcaId)) cache.set(mcaId, await loadTools(mcaId))

    const tools: Record<string, ToolPermission> = { ...(permissions?.tools ?? {}) }
    let changed = false
    for (const tool of cache.get(mcaId) ?? []) {
      if (tool.annotations?.sandboxedHint !== true || !isAllowedAtInstall(tool.annotations, true))
        continue
      if ((tools[tool.name] ?? "ask") !== "ask") continue
      tools[tool.name] = "allow"
      changed = true
    }
    if (!changed) {
      skipped++
      continue
    }
    await apps.updateOne(
      { _id: app._id },
      {
        $set: {
          permissions: { tools, defaultPermission: "ask" },
          updatedAt: new Date().toISOString(),
        },
      },
    )
    updated++
  }
  return { updated, skipped }
}

const migration: Migration = {
  description:
    "Allow sandboxed tools (sandboxedHint, e.g. computer GUI input) on agents' own app instances, keeping user pins",

  async up(db: Db): Promise<void> {
    const { updated, skipped } = await allowSandboxedToolsOnAgentApps(db)
    console.log(
      `[Migration] Sandboxed tools on agent apps: ${updated} apps updated, ${skipped} skipped`,
    )
  },

  async down(): Promise<void> {
    // Irreversible by design (see 20260704_002): the 'allow' entries are
    // indistinguishable from ones the user set afterwards.
    console.log("[Migration] down() is a no-op — permissions are user data after the seed")
  },
}

export default migration
