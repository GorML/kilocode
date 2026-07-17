// kilocode_change - new file
// K1 W1: verify the `kilo remote` command's call site for
// `KiloSessions.setInstanceAdvertisement` is gated on the
// `KILO_REMOTE_ATTACH_SESSION` env var.
//
// K2 (Wave 2) uses that env var to attach spawned children, and those
// children must never advertise themselves on the relay. This test
// locks in the env-gate structure so K2 can rely on it before K2 lands.
//
// The handler is a CLI entry point that calls `bootstrap(process.cwd(),
// async () => { ... })` and then awaits an abort signal — the abort
// never resolves, so we cannot drive the handler end-to-end. Instead we
// read the source and verify the gate structure, which is the
// contractually important thing: the setter must be inside an
// `if (!process.env["KILO_REMOTE_ATTACH_SESSION"])` block.

import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

describe("RemoteCommand env-gate (K1 W1)", () => {
  test("KiloSessions.setInstanceAdvertisement call site is gated on KILO_REMOTE_ATTACH_SESSION", async () => {
    // kilocode_change - `URL.pathname` for a `file://` URL on Windows keeps
    // a leading slash before the drive letter (e.g. `/C:/Users/...`), which
    // `Bun.file()` cannot resolve to the real path. `fileURLToPath` handles
    // the platform-specific conversion correctly on every OS.
    const filePath = fileURLToPath(new URL("../../../../src/cli/cmd/remote.ts", import.meta.url))
    const src = await Bun.file(filePath).text()

    // The env var must be referenced.
    expect(src).toContain("KILO_REMOTE_ATTACH_SESSION")

    // The gate must negate the env var.
    expect(src).toMatch(/!process\.env\["KILO_REMOTE_ATTACH_SESSION"\]/)

    // The setter call must be inside the if block — strictly more
    // indented than the if line.
    const lines = src.split("\n")
    const ifLine = lines.findIndex((l) => l.includes("if") && l.includes("KILO_REMOTE_ATTACH_SESSION"))
    expect(ifLine).toBeGreaterThanOrEqual(0)
    const setterLine = lines.findIndex((l) => l.includes("setInstanceAdvertisement"))
    expect(setterLine).toBeGreaterThan(ifLine)

    const ifIndent = lines[ifLine].search(/\S/)
    const setterIndent = lines[setterLine].search(/\S/)
    expect(setterIndent).toBeGreaterThan(ifIndent)
  })
})
