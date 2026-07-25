import { describe, expect, it } from "vitest"
import { __testing__ } from "../use-inspector"

describe("inspector target origin", () => {
  it("resolves relative preview URLs against the current page", () => {
    expect(
      __testing__.resolveTargetOrigin(
        "/preview/index.html",
        "https://tauri.localhost/app",
      ),
    ).toBe("https://tauri.localhost")
  })

  it("preserves the explicit preview server origin", () => {
    expect(
      __testing__.resolveTargetOrigin(
        "http://127.0.0.1:4173/index.html",
        "https://tauri.localhost/app",
      ),
    ).toBe("http://127.0.0.1:4173")
  })

  it("rejects missing, invalid, and opaque preview URLs", () => {
    expect(
      __testing__.resolveTargetOrigin(null, "https://tauri.localhost/app"),
    ).toBeNull()
    expect(
      __testing__.resolveTargetOrigin(
        "http://[invalid",
        "https://tauri.localhost/app",
      ),
    ).toBeNull()
    expect(
      __testing__.resolveTargetOrigin(
        "data:text/html,preview",
        "https://tauri.localhost/app",
      ),
    ).toBeNull()
  })
})
