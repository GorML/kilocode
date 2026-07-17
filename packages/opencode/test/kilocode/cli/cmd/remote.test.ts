// kilocode_change - new file
// K1 W1: verify `shouldAdvertiseInstance`'s gate and
// `buildInstanceAdvertisement`'s payload shape as real behavior.
//
// K2 (Wave 2) uses `KILO_REMOTE_ATTACH_SESSION` to attach spawned
// children, and those children must never advertise themselves on the
// relay. This test locks in that gate's actual behavior so K2 can rely on
// it before K2 lands.
//
// The `RemoteCommand` handler itself is a CLI entry point that calls
// `bootstrap(process.cwd(), async () => { ... })` and then awaits an abort
// signal that never resolves in a test — it cannot be driven end-to-end.
// `shouldAdvertiseInstance` and `buildInstanceAdvertisement` are extracted
// from the handler specifically so the gate and the advertised payload are
// each independently testable as real behavior, not via a source-text/regex
// assertion on the handler's structure.

import { describe, expect, test } from "bun:test"
import { buildInstanceAdvertisement, shouldAdvertiseInstance } from "../../../../src/cli/cmd/remote"

describe("RemoteCommand env-gate (K1 W1)", () => {
  test("advertises when KILO_REMOTE_ATTACH_SESSION is unset — the explicit `kilo remote` command path", () => {
    expect(shouldAdvertiseInstance({})).toBe(true)
    expect(shouldAdvertiseInstance({ KILO_REMOTE_ATTACH_SESSION: undefined })).toBe(true)
  })

  test("never advertises when KILO_REMOTE_ATTACH_SESSION is set — a K2-spawned child must stay off the picker", () => {
    expect(shouldAdvertiseInstance({ KILO_REMOTE_ATTACH_SESSION: "ses_abc123" })).toBe(false)
  })

  test("buildInstanceAdvertisement resolves name/projectName/version from the directory and installation version", () => {
    const advertisement = buildInstanceAdvertisement("/Users/igor/projects/my-app")
    expect(advertisement.projectName).toBe("my-app")
    expect(typeof advertisement.name).toBe("string")
    expect(advertisement.name.length).toBeGreaterThan(0)
    expect(typeof advertisement.version).toBe("string")
  })

  test("buildInstanceAdvertisement truncates an overlong project directory name to 64 chars", () => {
    const longName = "a".repeat(100)
    const advertisement = buildInstanceAdvertisement(`/Users/igor/projects/${longName}`)
    expect(advertisement.projectName.length).toBeLessThanOrEqual(64)
  })

  test("buildInstanceAdvertisement falls back to the full directory when basename is empty (root path)", () => {
    const advertisement = buildInstanceAdvertisement("/")
    expect(advertisement.projectName).toBe("/")
  })
})
