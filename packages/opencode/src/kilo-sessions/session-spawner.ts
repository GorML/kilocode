// kilocode_change - new file
//
// SessionSpawner (K2) — process-per-session spawn engine.
//
// Two spawn modes for the new child that will serve a freshly-created session:
//
//   1. **tmux** — when the parent itself is running inside tmux AND the
//      `tmux` binary is on `PATH`. Creates a new tmux window in the SAME
//      tmux server/session the parent lives in (`$TMUX` encodes the server
//      socket + session id). The child runs as the foreground process of
//      that new window, with `KILO_NO_DAEMON=1 KILO_REMOTE=1` plus the
//      `KILO_REMOTE_ATTACH_SESSION=<id>` and (when set) `KILO_SESSION_INGEST_URL`
//      passthrough — using the `env(1)`-prefix form for tmux 2.x portability.
//
//   2. **detached** — when tmux is unavailable (parent not in tmux, no
//      tmux binary, or tmux `new-window` itself failed). Daemon-pattern
//      `child_process.spawn` of `<self> remote`, with a full env copy plus
//      `KILO_REMOTE_ATTACH_SESSION=<id>` added, stdio routed to a per-session
//      log file, `.unref()` so the parent can exit. Mirrors the existing
//      `daemon.ts` detached-spawn precedent (log handle setup, flags).
//
// Windows always uses the detached path (tmux is not applicable).
//
// `KILO_NO_DAEMON=1` is load-bearing on the tmux path: a running
// `kilo daemon` / `kilo console` in the project would otherwise hijack the
// `--session` invocation via the TUI's daemon-attach short-circuit and serve
// the session inside the daemon process (violating process-per-session).

import { spawn as cpSpawn, spawnSync } from "node:child_process"
import { mkdir, open } from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { KiloPtySelfCommand } from "@/kilocode/pty/self-command"

export namespace SessionSpawner {
  export type Mode = "tmux" | "detached"

  export type ExecResult = { status: number | null; error?: Error }

  export type StdioTriple = [
    NodeJS.WritableStream | "ignore" | number,
    NodeJS.WritableStream | number,
    NodeJS.WritableStream | number,
  ]

  /** Minimal `child_process.spawn` shape used for the detached path. */
  export type ChildProcessLike = {
    unref(): void
    /**
     * Node surfaces a launch failure (ENOENT, bad cwd, permissions) via
     * this event, asynchronously, even though `spawn()` itself returns
     * synchronously — `create_session`'s response has already been sent
     * by the time this could fire (the wire contract pins response timing
     * to "spawn successfully initiated", not "child confirmed running";
     * waiting for readiness here would be a bigger scope change and is the
     * accepted plan's documented v1 risk / future upgrade path). This
     * listener exists purely for observability — it never affects the
     * caller.
     */
    on(event: "error", listener: (err: Error) => void): void
  }

  export type SpawnFn = (
    command: string,
    args: readonly string[],
    options: {
      cwd: string
      detached: boolean
      env: NodeJS.ProcessEnv
      stdio: StdioTriple
      windowsHide: boolean
    },
  ) => ChildProcessLike

  /**
   * Synchronous tmux probe — invokes `tmux -V` via the injected exec. A
   * non-zero exit, spawn error, or `ENOENT` all map to `available: false`.
   */
  export type ExecFileSyncFn = (command: string, args: readonly string[]) => ExecResult

  export type Deps = {
    self: { command: string; args: string[]; cwd?: string }
    env: NodeJS.ProcessEnv
    platform: NodeJS.Platform
    execFileSync: ExecFileSyncFn
    spawn: SpawnFn
    log: {
      info(message?: unknown, extra?: Record<string, unknown>): void
      error(message?: unknown, extra?: Record<string, unknown>): void
      warn(message?: unknown, extra?: Record<string, unknown>): void
    }
    logDir: string
  }

  export type Options = {
    sessionId: string
    directory: string
    deps: Deps
  }

  export type Result =
    | { mode: "tmux"; command: string; args: readonly string[] }
    | { mode: "detached"; command: string; args: readonly string[]; env: NodeJS.ProcessEnv; logFile: string }

  /**
   * Build a tmux `new-window` command for the child. The window is created in
   * the same tmux server/session the parent lives in (`$TMUX` in the spawner's
   * env already encodes the server socket + session). Pure function so tests
   * can assert the exact constructed command/args without invoking tmux.
   */
  export function buildTmuxCommand(input: {
    sessionId: string
    directory: string
    self: { command: string; args: string[]; cwd?: string }
    env: NodeJS.ProcessEnv
  }): { command: string; args: string[] } {
    const windowName = `kilo-${input.sessionId.slice(-6)}`
    // env(1)-prefix form (vs `tmux new-window -e`) for tmux 2.x portability.
    // We pass the inner command + args as a single `env ...` argv; the shell
    // is implicit because tmux executes argv directly without a shell.
    const ingest = input.env["KILO_SESSION_INGEST_URL"]
    const envArgs: string[] = [
      "env",
      "KILO_NO_DAEMON=1",
      "KILO_REMOTE=1",
      `KILO_REMOTE_ATTACH_SESSION=${input.sessionId}`,
    ]
    if (ingest) envArgs.push(`KILO_SESSION_INGEST_URL=${ingest}`)

    const inner: string[] = [...envArgs, input.self.command, ...input.self.args, "--session", input.sessionId]
    return {
      command: "tmux",
      args: ["new-window", "-c", input.directory, "-n", windowName, "--", ...inner],
    }
  }

  /**
   * Build the detached spawn payload. Mirrors the daemon's detached-spawn
   * precedent (env shape, stdio routing, cwd). The env is a full copy of
   * the spawner's env (unlike the tmux path, which must enumerate a prefix
   * because `tmux new-window` inherits the tmux *server's* captured env,
   * not the live spawning process's env).
   */
  export function buildDetachedPayload(input: {
    sessionId: string
    directory: string
    self: { command: string; args: string[]; cwd?: string }
    env: NodeJS.ProcessEnv
    logFile: string
  }): {
    command: string
    args: string[]
    env: NodeJS.ProcessEnv
    logFile: string
  } {
    const env: NodeJS.ProcessEnv = {
      ...input.env,
      KILO_REMOTE_ATTACH_SESSION: input.sessionId,
    }
    return {
      command: input.self.command,
      args: [...input.self.args, "remote"],
      env,
      logFile: input.logFile,
    }
  }

  function tmuxAvailable(deps: Deps): boolean {
    if (deps.platform === "win32") return false
    if (!deps.env["TMUX"]) return false
    const probe = deps.execFileSync("tmux", ["-V"])
    if (probe.error) return false
    if (probe.status === null) return false
    return probe.status === 0
  }

  /**
   * Spawn a new CLI process to serve the given session id. Returns the
   * resolved mode + the exact constructed argv/env (or, for tmux, the
   * constructed command before the actual `new-window` invocation). Throws
   * only on programmer errors; tmux failures fall back to detached.
   */
  export async function spawn(input: Options): Promise<Result> {
    const { sessionId, directory, deps } = input

    if (tmuxAvailable(deps)) {
      const built = buildTmuxCommand({
        sessionId,
        directory,
        self: deps.self,
        env: deps.env,
      })
      const probe = deps.execFileSync(built.command, built.args)
      if (!probe.error && probe.status === 0) {
        deps.log.info("session-spawner: tmux window created", { sessionId, windowName: `kilo-${sessionId.slice(-6)}` })
        return { mode: "tmux", command: built.command, args: built.args }
      }
      // tmux failed — fall through to detached. This is the documented
      // fallback: any tmux spawn failure (non-zero exit, spawn error) must
      // never propagate to the caller.
      deps.log.warn("session-spawner: tmux new-window failed, falling back to detached", {
        sessionId,
        status: probe.status,
        error: probe.error?.message,
      })
    }

    // The log file is only created for the mode that actually uses it —
    // the tmux path above never reaches here, so a caller testing tmux
    // mode selection (or, e.g., simulating a Windows platform purely to
    // assert routing) never needs a real `logDir` to exist.
    const logFile = path.join(deps.logDir, `remote-spawn-${sessionId}.log`)
    await mkdir(deps.logDir, { recursive: true })

    const built = buildDetachedPayload({
      sessionId,
      directory,
      self: deps.self,
      env: deps.env,
      logFile,
    })

    const handle = await open(logFile, "a")
    try {
      const child = deps.spawn(built.command, built.args, {
        cwd: directory,
        detached: true,
        env: built.env,
        stdio: ["ignore", handle.fd, handle.fd],
        windowsHide: true,
      })
      // Observability only (see ChildProcessLike.on's doc comment) — an
      // immediate launch failure is otherwise completely silent, which is
      // strictly worse for debugging than the plan's accepted "child
      // crashes after successfully launching" risk (that case at least
      // leaves a log file). Does not affect the already-sent response.
      child.on("error", (err) => {
        deps.log.warn("session-spawner: detached child failed to launch", { sessionId, error: String(err) })
      })
      child.unref()
    } finally {
      await handle.close().catch((err) => {
        deps.log.warn("session-spawner: failed to close detached child's log file handle", {
          sessionId,
          logFile,
          error: String(err),
        })
      })
    }
    deps.log.info("session-spawner: detached child spawned", { sessionId, logFile })
    return { mode: "detached", command: built.command, args: built.args, env: built.env, logFile }
  }

  /**
   * Resolve the deps for the production call site. `self` is captured
   * once at module load (matching the existing `KiloPtySelfCommand.command`
   * pattern in `background-process/runner.ts`); the env is the live
   * `process.env` at call time, so the KILO_SESSION_INGEST_URL passthrough
   * reflects what the spawning process actually sees.
   */
  export function defaultDeps(overrides: Partial<Deps> = {}): Deps {
    return {
      self: KiloPtySelfCommand.command(),
      env: process.env,
      platform: process.platform,
      execFileSync: defaultExecFileSync,
      spawn: defaultSpawn,
      log: overrides.log ?? { info: () => {}, error: () => {}, warn: () => {} },
      logDir: path.join(Global.Path.log, "remote-spawn"),
      ...overrides,
    }
  }

  function defaultExecFileSync(command: string, args: readonly string[]): ExecResult {
    try {
      const result = spawnSync(command, [...args], { stdio: "ignore" })
      return { status: result.status }
    } catch (error) {
      return { status: null, error: error instanceof Error ? error : new Error(String(error)) }
    }
  }

  function defaultSpawn(
    command: string,
    args: readonly string[],
    options: {
      cwd: string
      detached: boolean
      env: NodeJS.ProcessEnv
      stdio: StdioTriple
      windowsHide: boolean
    },
  ): ChildProcessLike {
    return cpSpawn(command, [...args], options as unknown as Parameters<typeof cpSpawn>[2])
  }

  /** Factory for wiring into `RemoteSender.Options` as a single-call seam. */
  export type SpawnSession = (input: { sessionId: string; directory: string }) => Promise<Result>

  export function create(overrides: Partial<Deps> = {}): SpawnSession {
    const deps = defaultDeps(overrides)
    return async ({ sessionId, directory }) => spawn({ sessionId, directory, deps })
  }
}
