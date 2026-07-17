// kilocode_change - new file
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { SessionSpawner } from "../../../src/kilo-sessions/session-spawner"

const nolog = {
  info: () => {},
  error: () => {},
  warn: () => {},
}

function silentExecOk() {
  return (command: string, args: readonly string[]) => {
    return { status: 0 as number | null }
  }
}

function silentExecFail(status: number | null = 1, error?: Error) {
  return (command: string, args: readonly string[]) => {
    return { status, ...(error ? { error } : {}) }
  }
}

function fakeSpawn(): {
  spawn: SessionSpawner.SpawnFn
  calls: Array<{ command: string; args: readonly string[]; options: Parameters<SessionSpawner.SpawnFn>[2] }>
} {
  const calls: Array<{ command: string; args: readonly string[]; options: Parameters<SessionSpawner.SpawnFn>[2] }> = []
  return {
    spawn: (command, args, options) => {
      calls.push({ command, args, options })
      return { unref: () => {}, on: () => {} }
    },
    calls,
  }
}

const SELF = { command: "/usr/local/bin/kilo", args: ["--from", "global"] }
const INGEST_UNSET_ENV = { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv
const INGEST_SET_ENV = {
  PATH: "/usr/bin:/bin",
  KILO_SESSION_INGEST_URL: "https://ingest.local.example.com",
} as NodeJS.ProcessEnv

afterEach(() => {
  delete process.env["TMUX"]
})

describe("SessionSpawner.buildTmuxCommand", () => {
  test("constructs exact env(1)-prefix argv with all load-bearing vars and --session", () => {
    const out = SessionSpawner.buildTmuxCommand({
      sessionId: "ses_abc123def456",
      directory: "/workspace/proj",
      self: SELF,
      env: INGEST_UNSET_ENV,
    })
    expect(out.command).toBe("tmux")
    expect(out.args).toEqual([
      "new-window",
      "-c",
      "/workspace/proj",
      "-n",
      "kilo-def456", // last 6 chars of sessionId
      "--",
      "env",
      "KILO_NO_DAEMON=1",
      "KILO_REMOTE=1",
      "KILO_REMOTE_ATTACH_SESSION=ses_abc123def456",
      "/usr/local/bin/kilo",
      "--from",
      "global",
      "--session",
      "ses_abc123def456",
    ])
  })

  test("includes KILO_SESSION_INGEST_URL passthrough when set in spawner env", () => {
    const out = SessionSpawner.buildTmuxCommand({
      sessionId: "ses_xyz789",
      directory: "/p",
      self: SELF,
      env: INGEST_SET_ENV,
    })
    expect(out.args).toContain("KILO_SESSION_INGEST_URL=https://ingest.local.example.com")
    // Sanity: the order has the env-prefix in order, with the ingest value before the inner command.
    const ingestIdx = out.args.indexOf("KILO_SESSION_INGEST_URL=https://ingest.local.example.com")
    const innerIdx = out.args.indexOf("/usr/local/bin/kilo")
    expect(ingestIdx).toBeGreaterThan(0)
    expect(innerIdx).toBeGreaterThan(ingestIdx)
  })

  test("omits KILO_SESSION_INGEST_URL when NOT set in spawner env (passthrough is load-bearing)", () => {
    const out = SessionSpawner.buildTmuxCommand({
      sessionId: "ses_xyz789",
      directory: "/p",
      self: SELF,
      env: INGEST_UNSET_ENV,
    })
    expect(out.args.find((a) => a.startsWith("KILO_SESSION_INGEST_URL="))).toBeUndefined()
  })

  test("uses last 6 chars of sessionId for window name regardless of full id length", () => {
    const a = SessionSpawner.buildTmuxCommand({
      sessionId: "ses_abcdef",
      directory: "/p",
      self: SELF,
      env: INGEST_UNSET_ENV,
    })
    const b = SessionSpawner.buildTmuxCommand({
      sessionId: "ses_xxabcdef",
      directory: "/p",
      self: SELF,
      env: INGEST_UNSET_ENV,
    })
    // argv: ["new-window", "-c", "/p", "-n", <name>, "--", "env", ...]
    expect(a.args[4]).toBe("kilo-abcdef") // last 6 chars of "ses_abcdef" = "abcdef"
    expect(b.args[4]).toBe("kilo-abcdef") // last 6 chars of "ses_xxabcdef" = "abcdef"
  })
})

describe("SessionSpawner.buildDetachedPayload", () => {
  test("includes full env copy plus KILO_REMOTE_ATTACH_SESSION", () => {
    const out = SessionSpawner.buildDetachedPayload({
      sessionId: "ses_det",
      directory: "/p",
      self: SELF,
      env: { A: "1", B: "2" },
      logFile: "/log/x",
    })
    expect(out.command).toBe("/usr/local/bin/kilo")
    expect(out.args).toEqual(["--from", "global", "remote"])
    expect(out.env["A"]).toBe("1")
    expect(out.env["B"]).toBe("2")
    expect(out.env["KILO_REMOTE_ATTACH_SESSION"]).toBe("ses_det")
  })

  test("does NOT add KILO_REMOTE=1 (the `remote` subcommand handles that on its own)", () => {
    const out = SessionSpawner.buildDetachedPayload({
      sessionId: "ses_det",
      directory: "/p",
      self: SELF,
      env: {},
      logFile: "/log/x",
    })
    expect(out.env["KILO_REMOTE"]).toBeUndefined()
  })
})

describe("SessionSpawner.spawn", () => {
  beforeEach(() => {
    delete process.env["TMUX"]
  })

  test("uses tmux path when $TMUX is set and tmux is on PATH; returns exact tmux argv", async () => {
    process.env["TMUX"] = "/tmp/tmux-1000/default,12345,0"
    const fake = fakeSpawn()
    const result = await SessionSpawner.spawn({
      sessionId: "ses_tmux",
      directory: "/workspace/proj",
      deps: {
        self: SELF,
        env: process.env,
        platform: "linux",
        execFileSync: silentExecOk(),
        spawn: fake.spawn,
        log: nolog,
        logDir: "/tmp/spawner-logs",
      },
    })
    expect(result.mode).toBe("tmux")
    if (result.mode === "tmux") {
      expect(result.command).toBe("tmux")
      expect(result.args).toContain("new-window")
      expect(result.args).toContain("KILO_NO_DAEMON=1")
      expect(result.args).toContain("KILO_REMOTE=1")
      expect(result.args).toContain("KILO_REMOTE_ATTACH_SESSION=ses_tmux")
      // The detached spawn seam was NOT called.
      expect(fake.calls).toHaveLength(0)
    }
  })

  test("uses detached path when $TMUX is unset", async () => {
    const fake = fakeSpawn()
    const result = await SessionSpawner.spawn({
      sessionId: "ses_no_tmux",
      directory: "/workspace/proj",
      deps: {
        self: SELF,
        env: { PATH: "/usr/bin" },
        platform: "linux",
        execFileSync: silentExecOk(),
        spawn: fake.spawn,
        log: nolog,
        logDir: "/tmp/spawner-logs",
      },
    })
    expect(result.mode).toBe("detached")
    expect(fake.calls).toHaveLength(1)
  })

  test("uses detached path when tmux binary probe fails (no PATH)", async () => {
    process.env["TMUX"] = "/tmp/tmux-1000/default,12345,0"
    const fake = fakeSpawn()
    const result = await SessionSpawner.spawn({
      sessionId: "ses_no_tmux_bin",
      directory: "/workspace/proj",
      deps: {
        self: SELF,
        env: process.env,
        platform: "linux",
        execFileSync: silentExecFail(127),
        spawn: fake.spawn,
        log: nolog,
        logDir: "/tmp/spawner-logs",
      },
    })
    expect(result.mode).toBe("detached")
    expect(fake.calls).toHaveLength(1)
  })

  test("uses detached path when tmux new-window exits non-zero (falls back, never throws)", async () => {
    process.env["TMUX"] = "/tmp/tmux-1000/default,12345,0"
    const fake = fakeSpawn()
    const execCalls: Array<{ command: string; args: readonly string[] }> = []
    const execFileSync: SessionSpawner.ExecFileSyncFn = (command, args) => {
      execCalls.push({ command, args })
      if (args[0] === "-V") return { status: 0 }
      return { status: 1 } // new-window failed
    }
    const result = await SessionSpawner.spawn({
      sessionId: "ses_tmux_fail",
      directory: "/workspace/proj",
      deps: {
        self: SELF,
        env: process.env,
        platform: "linux",
        execFileSync,
        spawn: fake.spawn,
        log: nolog,
        logDir: "/tmp/spawner-logs",
      },
    })
    expect(result.mode).toBe("detached")
    // The probe was called twice: once for the -V availability check, once
    // for the actual new-window invocation.
    expect(execCalls).toHaveLength(2)
    expect(execCalls[0]?.args[0]).toBe("-V")
    expect(execCalls[1]?.args).toContain("new-window")
    expect(fake.calls).toHaveLength(1)
  })

  test("uses detached path on Windows (tmux never applicable)", async () => {
    const fake = fakeSpawn()
    const result = await SessionSpawner.spawn({
      sessionId: "ses_win",
      directory: "C:\\workspace\\proj",
      deps: {
        self: SELF,
        env: { TMUX: "anything" },
        platform: "win32",
        execFileSync: silentExecOk(),
        spawn: fake.spawn,
        log: nolog,
        // kilocode_change - `logDir` is a real filesystem path the
        // production code `mkdir`s and opens a log file under, regardless
        // of the simulated `platform`. A literal Windows-style string
        // (e.g. "C:\\logs") is NOT absolute on POSIX, so it would resolve
        // relative to the test runner's cwd and create a stray
        // `C:\logs/` directory inside the repo worktree. Use a real,
        // POSIX-safe temp path here — the test asserts mode SELECTION
        // (which is platform-driven), not the log path's own shape.
        logDir: "/tmp/spawner-logs",
      },
    })
    expect(result.mode).toBe("detached")
  })

  test("detached spawn: detached: true, stdio routed to log file, windowsHide: true, .unref() called", async () => {
    const fake = fakeSpawn()
    let unrefCalls = 0
    fake.spawn = (command, args, options) => {
      fake.calls.push({ command, args, options })
      return {
        unref: () => {
          unrefCalls += 1
        },
        on: () => {},
      }
    }
    const result = await SessionSpawner.spawn({
      sessionId: "ses_det_test",
      directory: "/workspace/det",
      deps: {
        self: SELF,
        env: { PATH: "/usr/bin" },
        platform: "linux",
        execFileSync: silentExecOk(),
        spawn: fake.spawn,
        log: nolog,
        logDir: "/tmp/spawner-logs",
      },
    })
    expect(result.mode).toBe("detached")
    expect(fake.calls).toHaveLength(1)
    const call = fake.calls[0]!
    expect(call.options.cwd).toBe("/workspace/det")
    expect(call.options.detached).toBe(true)
    expect(call.options.windowsHide).toBe(true)
    expect(call.options.env["KILO_REMOTE_ATTACH_SESSION"]).toBe("ses_det_test")
    // stdio is [ignore, fd, fd] — first slot is "ignore", rest are file descriptors.
    expect(call.options.stdio[0]).toBe("ignore")
    expect(typeof call.options.stdio[1]).toBe("number")
    expect(typeof call.options.stdio[2]).toBe("number")
    expect(unrefCalls).toBe(1)
  })

  test("detached spawn: an async launch failure is logged (observability only — response already sent, no rollback)", async () => {
    const fake = fakeSpawn()
    let errorListener: ((err: Error) => void) | undefined
    const warnCalls: Array<{ message: string; meta: unknown }> = []
    fake.spawn = (command, args, options) => {
      fake.calls.push({ command, args, options })
      return {
        unref: () => {},
        on: (_event, listener) => {
          errorListener = listener
        },
      }
    }
    const result = await SessionSpawner.spawn({
      sessionId: "ses_launch_fail",
      directory: "/workspace/det",
      deps: {
        self: SELF,
        env: { PATH: "/usr/bin" },
        platform: "linux",
        execFileSync: silentExecOk(),
        spawn: fake.spawn,
        log: {
          info: () => {},
          error: () => {},
          warn: (message?: unknown, meta?: Record<string, unknown>) =>
            warnCalls.push({ message: String(message), meta }),
        },
        logDir: "/tmp/spawner-logs",
      },
    })
    // The response-shaping result is unaffected — spawn() already returned
    // successfully by the time an async launch failure could occur.
    expect(result.mode).toBe("detached")
    expect(errorListener).toBeDefined()
    errorListener?.(new Error("spawn ENOENT"))
    expect(warnCalls).toHaveLength(1)
    expect(warnCalls[0]?.message).toContain("failed to launch")
    expect(warnCalls[0]?.meta).toMatchObject({ sessionId: "ses_launch_fail" })
  })

  test("detached spawn log file lives under logDir with the session id in its name", async () => {
    const fake = fakeSpawn()
    const logDir = path.join(process.env["TMPDIR"] ?? "/tmp", "spawner-logs-" + Date.now())
    const result = await SessionSpawner.spawn({
      sessionId: "ses_log_path",
      directory: "/d",
      deps: {
        self: SELF,
        env: {},
        platform: "linux",
        execFileSync: silentExecOk(),
        spawn: fake.spawn,
        log: nolog,
        logDir,
      },
    })
    expect(result.mode).toBe("detached")
    if (result.mode === "detached") {
      expect(result.logFile).toBe(path.join(logDir, "remote-spawn-ses_log_path.log"))
    }
  })

  test("detached spawn env is a full copy (not just an attach-id prefix) — preserved entries from spawner env", async () => {
    const fake = fakeSpawn()
    await SessionSpawner.spawn({
      sessionId: "ses_env_copy",
      directory: "/d",
      deps: {
        self: SELF,
        env: {
          PATH: "/u/b",
          KILO_SESSION_INGEST_URL: "https://ingest.example.com",
          OTHER: "preserved",
        },
        platform: "linux",
        execFileSync: silentExecOk(),
        spawn: fake.spawn,
        log: nolog,
        logDir: "/tmp/logs",
      },
    })
    const call = fake.calls[0]!
    expect(call.options.env["PATH"]).toBe("/u/b")
    expect(call.options.env["KILO_SESSION_INGEST_URL"]).toBe("https://ingest.example.com")
    expect(call.options.env["OTHER"]).toBe("preserved")
    expect(call.options.env["KILO_REMOTE_ATTACH_SESSION"]).toBe("ses_env_copy")
  })
})
