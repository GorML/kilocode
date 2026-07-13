import { describe, expect, test } from "bun:test"
import { readBoundedJson } from "@/kilocode/cloud/response-json"

describe("readBoundedJson", () => {
  test("cancels a response body rejected by its content length", async () => {
    const state = { canceled: false }
    const body = new ReadableStream({
      cancel() {
        state.canceled = true
      },
    })
    const response = new Response(body, { headers: { "content-length": "11" } })

    await expect(readBoundedJson(response, 10)).rejects.toThrow("JSON response exceeds the configured limit")
    expect(state.canceled).toBe(true)
  })
})
