/**
 * Render test for the Computer renderer (mca.teros.computer): plain-language
 * header per tool and the "Open computer" action that opens the live view of
 * that exact computer (by appId).
 */

import { fireEvent } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { renderWithTamagui } from "../../../test/renderWithTamagui"

// Deterministic `t` (returns the key), as in ProviderErrorWidget.render.test.
vi.mock("react-i18next", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

const openWindow = vi.fn()
vi.mock("../../../store/tilingStore", () => ({
  useTilingStore: (selector: (s: { openWindow: typeof openWindow }) => unknown) =>
    selector({ openWindow }),
}))

const { ComputerToolCallRenderer, describeComputerCall } = await import("./ComputerRenderer")

describe("describeComputerCall", () => {
  it("names the action and its target", () => {
    expect(describeComputerCall("computer-ana_open-url", { url: "https://example.com" }).past).toBe(
      "Opened a page · https://example.com",
    )
    expect(describeComputerCall("computer-ana_press-key", { keys: "ctrl+l" }).present).toBe(
      "Pressing keys · ctrl+l",
    )
    expect(describeComputerCall("computer-ana_get-state").past).toBe("Looked at the screen")
  })
})

describe("ComputerToolCallRenderer", () => {
  it("opens the live view of this computer", () => {
    const { getByText } = renderWithTamagui(
      <ComputerToolCallRenderer
        toolCallId="tc1"
        toolName="computer-ana_click"
        status="completed"
        appId="app_123"
        output="Clicked e3."
      />,
    )
    expect(getByText("Clicked")).toBeTruthy()
    fireEvent.click(getByText("computer.openLiveView"))
    expect(openWindow).toHaveBeenCalledWith("computer", { appId: "app_123" }, true)
  })

  it("falls back to the app name from the tool name (stored tool messages have no appId)", () => {
    const { getByText } = renderWithTamagui(
      <ComputerToolCallRenderer toolCallId="tc2" toolName="computer-ana_scroll" status="running" />,
    )
    fireEvent.click(getByText("computer.openLiveView"))
    expect(openWindow).toHaveBeenCalledWith("computer", { appName: "computer-ana" }, true)
  })

  it("has no live-view action when the computer can't be identified", () => {
    const { queryByText } = renderWithTamagui(
      <ComputerToolCallRenderer toolCallId="tc3" toolName="scroll" status="running" />,
    )
    expect(queryByText("computer.openLiveView")).toBeNull()
  })
})
