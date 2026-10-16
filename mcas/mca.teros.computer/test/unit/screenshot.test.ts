import { describe, expect, it } from "bun:test"
import sharp from "sharp"
import { encodeShot } from "../../src/screenshot"

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 30, g: 60, b: 90 } } })
    .png()
    .toBuffer()
}

describe("encodeShot", () => {
  it("downscales to the requested width and reports the scale", async () => {
    const shot = await encodeShot(await png(1280, 800), 1024, 60)
    expect(shot).toMatchObject({ mime: "image/jpeg", width: 1024, height: 640, scale: 1.25 })
    expect(shot.data.subarray(0, 2).toString("hex")).toBe("ffd8")
  })

  it("never upscales", async () => {
    const shot = await encodeShot(await png(800, 600), 1024, 60)
    expect(shot).toMatchObject({ width: 800, scale: 1 })
  })
})
