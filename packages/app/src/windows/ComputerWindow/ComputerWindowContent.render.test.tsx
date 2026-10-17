/**
 * ComputerWindowContent: asks the backend for a fresh live-view URL on mount
 * (never a stored one) and embeds it; shows a retry path when opening fails;
 * understands the viewer's postMessage protocol.
 */

import { waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { renderWithTamagui } from "../../test/renderWithTamagui"

// Deterministic `t` (returns the key), as in ProviderErrorWidget.render.test.
vi.mock("react-i18next", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

const open = vi.fn()
vi.mock("../../services/terosClientSingleton", () => ({
  getTerosClient: () => ({ computer: { open } }),
}))
vi.mock("../../store/workspaceStore", () => ({
  useWorkspaceStore: (selector: (s: { activeWorkspaceId: string }) => unknown) =>
    selector({ activeWorkspaceId: "work_active" }),
}))

const { ComputerWindowContent, parseViewerMessage } = await import("./ComputerWindowContent")

describe("ComputerWindowContent", () => {
  it("opens the agent’s computer in the active workspace and embeds the signed view", async () => {
    open.mockResolvedValueOnce({
      appId: "app_1",
      appName: "computer-ana",
      viewUrl: "https://api.teros.test/computer/aa.bb/",
      expiresAt: "",
    })
    const { container, getByText } = renderWithTamagui(
      <ComputerWindowContent windowId="w1" agentId="agent_1" />,
    )
    await waitFor(() => expect(container.querySelector("iframe")).toBeTruthy())
    expect(open).toHaveBeenCalledWith({
      agentId: "agent_1",
      appId: undefined,
      workspaceId: "work_active",
    })
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
      "https://api.teros.test/computer/aa.bb/",
    )
    expect(getByText("computer-ana")).toBeTruthy()
    expect(getByText("computer.agentDriving")).toBeTruthy()
  })

  it("shows the error with a retry when the computer can’t be opened", async () => {
    open.mockRejectedValueOnce(new Error("COMPUTER_UNAVAILABLE"))
    const { findByText } = renderWithTamagui(
      <ComputerWindowContent windowId="w2" agentId="agent_1" />,
    )
    expect(await findByText("COMPUTER_UNAVAILABLE")).toBeTruthy()
    expect(await findByText("computer.retry")).toBeTruthy()
  })
})

describe("parseViewerMessage", () => {
  it("reads control changes and expiry, ignores anything else", () => {
    expect(parseViewerMessage({ type: "teros-computer-control", holder: "human" })).toEqual({
      holder: "human",
    })
    expect(parseViewerMessage({ type: "teros-computer-expired" })).toEqual({ expired: true })
    expect(parseViewerMessage({ type: "teros-computer-control", holder: "root" })).toBeNull()
    expect(parseViewerMessage("hello")).toBeNull()
  })
})
