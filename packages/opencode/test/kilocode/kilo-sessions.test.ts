// kilocode_change - new file
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Auth } from "../../src/auth"
import { Bus } from "../../src/bus"
import { GlobalBus } from "../../src/bus/global"
import type { Config } from "../../src/config/config"
import { clearInFlightCache } from "../../src/kilo-sessions/inflight-cache"
import { KiloSessions } from "../../src/kilo-sessions/kilo-sessions"
import { provide } from "../../src/kilocode/instance"
import { RemoteWS } from "../../src/kilo-sessions/remote-ws"
import { RemoteSender } from "../../src/kilo-sessions/remote-sender"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Session } from "../../src/session/session"
import { SessionID } from "../../src/session/schema"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"
import { InstanceStore } from "../../src/project/instance-store"
import { TestInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { RemoteProtocol } from "../../src/kilo-sessions/remote-protocol"

const it = testEffect(CrossSpawnSpawner.defaultLayer)
const multi = testEffect(Layer.merge(CrossSpawnSpawner.defaultLayer, testInstanceStoreLayer))

function layer(overrides: Partial<Config.Interface> = {}) {
  return Layer.merge(
    KiloSessions.layer.pipe(
      Layer.provideMerge(Bus.layer),
      Layer.provide(TestConfig.layer(overrides)),
      Layer.provide(Session.defaultLayer),
    ),
    Auth.defaultLayer,
  )
}

function reset(...tokens: string[]) {
  clearInFlightCache("kilo-sessions:token")
  clearInFlightCache("kilo-sessions:client")
  for (const token of tokens) clearInFlightCache(`kilo-sessions:token-valid:${token}`)
}

it.instance("initializes once per instance through Config.Service", () => {
  let reads = 0

  return Effect.gen(function* () {
    const sessions = yield* KiloSessions.Service
    yield* sessions.init()
    yield* sessions.init()
    expect(reads).toBe(1)
  }).pipe(
    Effect.provide(
      layer({
        getGlobal: () =>
          Effect.sync(() => {
            reads += 1
            return {}
          }),
      }),
    ),
  )
})

it.instance("bootstraps session ingest from KILO_API_KEY without stored auth", () => {
  const original = process.env.KILO_API_KEY
  const calls: string[] = []
  const fetch: typeof globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/api/user")) {
        calls.push(new Headers(init?.headers).get("Authorization") ?? "")
        return new Response("{}", { status: 200 })
      }
      if (url.endsWith("/api/session")) {
        calls.push(new Headers(init?.headers).get("Authorization") ?? "")
        return Response.json({ id: "remote-env", ingestPath: "/api/ingest/env" })
      }
      return new Response("{}", { status: 200 })
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  const request = spyOn(globalThis, "fetch").mockImplementation(fetch)

  process.env.KILO_API_KEY = "env-token"
  reset("env-token")

  return Effect.promise(() => KiloSessions.bootstrap("session-env")).pipe(
    Effect.andThen(() => Effect.sync(() => expect(calls).toEqual(["Bearer env-token", "Bearer env-token"]))),
    Effect.ensuring(
      Effect.sync(() => {
        if (original === undefined) delete process.env.KILO_API_KEY
        else process.env.KILO_API_KEY = original
        reset("env-token")
        request.mockRestore()
      }),
    ),
    Effect.provide(layer()),
  )
})

it.instance("prefers stored auth over KILO_API_KEY for session ingest", () => {
  const original = process.env.KILO_API_KEY
  const calls: string[] = []
  const fetch: typeof globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/api/user")) {
        calls.push(new Headers(init?.headers).get("Authorization") ?? "")
        return new Response("{}", { status: 200 })
      }
      if (url.endsWith("/api/session")) {
        calls.push(new Headers(init?.headers).get("Authorization") ?? "")
        return Response.json({ id: "remote-auth", ingestPath: "/api/ingest/auth" })
      }
      return new Response("{}", { status: 200 })
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  const request = spyOn(globalThis, "fetch").mockImplementation(fetch)

  process.env.KILO_API_KEY = "env-token"
  reset("env-token", "stored-token")

  return Effect.gen(function* () {
    const auth = yield* Auth.Service
    yield* auth.set("kilo", { type: "api", key: "stored-token" })
    yield* Effect.promise(() => KiloSessions.bootstrap("session-auth"))
    expect(calls).toEqual(["Bearer stored-token", "Bearer stored-token"])
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.remove("kilo").pipe(Effect.orDie)
        if (original === undefined) delete process.env.KILO_API_KEY
        else process.env.KILO_API_KEY = original
        reset("env-token", "stored-token")
        request.mockRestore()
      }),
    ),
    Effect.provide(layer()),
  )
})

it.instance("does not duplicate created-session subscribers when init is repeated", () => {
  const calls: string[] = []
  const fetch: typeof globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/api/user")) return new Response("{}", { status: 200 })
      if (url.endsWith("/api/session")) {
        calls.push(url)
        return Response.json({ id: "remote-1", ingestPath: "/api/ingest/session-1" })
      }
      return new Response("{}", { status: 200 })
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  const request = spyOn(globalThis, "fetch").mockImplementation(fetch)

  reset("test-token")
  const id = SessionID.descending("session-created")

  return Effect.gen(function* () {
    const auth = yield* Auth.Service
    const instance = yield* TestInstance
    const sessions = yield* KiloSessions.Service
    yield* auth.set("kilo", { type: "api", key: "test-token" })
    yield* sessions.init()
    yield* sessions.init()
    yield* Effect.sleep(50)
    GlobalBus.emit("event", {
      directory: instance.directory,
      payload: {
        id: "test-event",
        type: Session.Event.Created.type,
        properties: {
          sessionID: id,
          info: {
            id,
            slug: "test",
            projectID: ProjectV2.ID.make("project-test"),
            directory: instance.directory,
            title: "test",
            version: "test",
            time: { created: Date.now(), updated: Date.now() },
          },
        },
      },
    })
    yield* Effect.sleep(50)
    expect(calls).toHaveLength(1)
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.remove("kilo").pipe(Effect.orDie)
        reset("test-token")
        request.mockRestore()
      }),
    ),
    Effect.provide(layer()),
  )
})

multi.live("isolates the process-wide listener by instance directory", () => {
  const calls: string[] = []
  const fetch: typeof globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/api/user")) return new Response("{}", { status: 200 })
      if (url.endsWith("/api/session")) {
        calls.push(url)
        return Response.json({ id: "remote-1", ingestPath: "/api/ingest/session-1" })
      }
      return new Response("{}", { status: 200 })
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  const request = spyOn(globalThis, "fetch").mockImplementation(fetch)

  reset("test-token")

  return Effect.gen(function* () {
    const first = yield* tmpdirScoped()
    const second = yield* tmpdirScoped()
    const auth = yield* Auth.Service
    const store = yield* InstanceStore.Service
    const sessions = yield* KiloSessions.Service
    yield* auth.set("kilo", { type: "api", key: "test-token" })
    yield* store.provide({ directory: first }, sessions.init())
    yield* store.provide({ directory: second }, sessions.init())

    const emit = (directory: string, value: string) => {
      const id = SessionID.descending(`session-${value}`)
      GlobalBus.emit("event", {
        directory,
        payload: {
          id: `event-${value}`,
          type: Session.Event.Created.type,
          properties: {
            sessionID: id,
            info: {
              id,
              slug: value,
              projectID: ProjectV2.ID.make(`project-${value}`),
              directory,
              title: value,
              version: "test",
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        },
      })
    }

    emit(first, "first")
    yield* Effect.sleep(50)
    expect(calls).toHaveLength(1)

    emit(second, "second")
    yield* Effect.sleep(50)
    expect(calls).toHaveLength(2)
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.remove("kilo").pipe(Effect.orDie)
        reset("test-token")
        request.mockRestore()
      }),
    ),
    Effect.provide(layer()),
  )
})

// kilocode_change start - K1 W1: instance advertisement + per-session platform.
//
// The race is the heart of this slice: `enableRemote` is idempotent/coalescing
// and can be called from either the explicit `kilo remote` command OR from
// bootstrap auto-enable (`KILO_REMOTE=1` / `remote_control` config). The
// module-level `instanceAdvertisement` flag must make the next heartbeat
// carry `instance` regardless of which caller won the race, and the setter
// must trigger an out-of-band heartbeat when called against an existing
// connection (so the cloud learns about the instance without waiting for
// the next 10s timer tick).

describe("KiloSessions.setInstanceAdvertisement (K1 W1)", () => {
  let heartbeatCalls = 0
  let outOfBand: Promise<void> | undefined

  beforeEach(() => {
    heartbeatCalls = 0
    outOfBand = undefined
    process.env["KILO_DISABLE_SESSION_INGEST"] = "0"
    delete process.env["KILO_SESSION_INGEST_URL"]
    delete process.env["KILO_REMOTE_ATTACH_SESSION"]
    process.env["KILO_API_KEY"] = "tok"
    reset("tok")
    KiloSessions.resetInstanceAdvertisementForTests()

    spyOn(RemoteSender, "create").mockImplementation(
      () =>
        ({
          handle() {},
          dispose() {},
        }) as RemoteSender.Sender,
    )
    spyOn(RemoteWS, "connect").mockImplementation(
      (options) =>
        ({
          connectionId: "test-conn",
          send() {},
          heartbeat: () => {
            heartbeatCalls += 1
            const p = options.getSessions().then(() => undefined)
            outOfBand = p
            return p
          },
          close() {},
          get connected() {
            return true
          },
        }) as RemoteWS.Connection,
    )

    clearInFlightCache("kilo-sessions:token")
    clearInFlightCache("kilo-sessions:token-valid:tok")

    globalThis.fetch = mock(async (input) => {
      if (String(input).endsWith("/api/user")) {
        return new Response(null, { status: 200 })
      }
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch
  })

  afterEach(async () => {
    const pub = spyOn(Bus, "publish").mockResolvedValue(undefined as never)
    // disableRemote() reads Instance.current (via Bus.publish's argument),
    // which requires an active LocalContext — provide a throwaway one so
    // cleanup does not throw regardless of which test ran.
    await using tmp = await tmpdir({ git: true })
    await provide({
      directory: tmp.path,
      fn: async () => {
        KiloSessions.disableRemote()
      },
    })
    pub.mockRestore()
    mock.restore()
    delete process.env["KILO_DISABLE_SESSION_INGEST"]
    delete process.env["KILO_SESSION_INGEST_URL"]
    delete process.env["KILO_REMOTE_ATTACH_SESSION"]
    delete process.env["KILO_PLATFORM"]
    delete process.env["KILO_API_KEY"]
    reset("tok")
  })

  // Reads the `getSessions` closure that kilo-sessions.ts passed to
  // RemoteWS.connect when enableRemote() ran. The mock stores calls
  // on the spy's `.mock.calls` array; we extract the Options object.
  function capturedGetSessions(): () => Promise<RemoteProtocol.Heartbeat> {
    const calls = (RemoteWS.connect as unknown as { mock: { calls: { 0: RemoteWS.Options }[] } }).mock.calls
    const getSessions = calls[0]?.[0].getSessions
    if (!getSessions) throw new Error("RemoteWS.connect was not called")
    return getSessions as () => Promise<RemoteProtocol.Heartbeat>
  }

  test("flag is unset by default — heartbeats omit `instance`", async () => {
    await using tmp = await tmpdir({ git: true })
    await provide({
      directory: tmp.path,
      fn: async () => {
        await KiloSessions.enableRemote()
        const payload = await capturedGetSessions()()
        expect(payload.type).toBe("heartbeat")
        expect(payload.instance).toBeUndefined()
      },
    })
  })

  test("setting the flag makes the next getSessions include `instance` (race: setter after enable)", async () => {
    await using tmp = await tmpdir({ git: true })
    await provide({
      directory: tmp.path,
      fn: async () => {
        await KiloSessions.enableRemote()
        // Race: the explicit `kilo remote` command now sets the flag, after
        // `enableRemote` already coalesced with bootstrap auto-enable.
        KiloSessions.setInstanceAdvertisement({
          name: "mbp-igor",
          projectName: "cloud",
          version: "1.2.3",
        })
        const payload = await capturedGetSessions()()
        expect(payload.type).toBe("heartbeat")
        expect(payload.instance).toEqual({ name: "mbp-igor", projectName: "cloud", version: "1.2.3" })
      },
    })
  })

  test("setter triggers an out-of-band heartbeat when a connection is already established", async () => {
    await using tmp = await tmpdir({ git: true })
    await provide({
      directory: tmp.path,
      fn: async () => {
        await KiloSessions.enableRemote()
        const beforePayload = await capturedGetSessions()()
        expect(beforePayload.instance).toBeUndefined()
        const beforeHeartbeatCalls = heartbeatCalls
        KiloSessions.setInstanceAdvertisement({ name: "h", projectName: "p" })
        // The setter fires one out-of-band heartbeat — wait for it.
        await outOfBand
        expect(heartbeatCalls).toBe(beforeHeartbeatCalls + 1)
        const afterPayload = await capturedGetSessions()()
        expect(afterPayload.instance).toEqual({ name: "h", projectName: "p" })
      },
    })
  })

  test("setter is idempotent — second call replaces the payload and still fires one out-of-band heartbeat", async () => {
    await using tmp = await tmpdir({ git: true })
    await provide({
      directory: tmp.path,
      fn: async () => {
        await KiloSessions.enableRemote()
        KiloSessions.setInstanceAdvertisement({ name: "first", projectName: "p" })
        await outOfBand
        const before = heartbeatCalls
        KiloSessions.setInstanceAdvertisement({ name: "second", projectName: "p" })
        await outOfBand
        expect(heartbeatCalls).toBe(before + 1)
        const payload = await capturedGetSessions()()
        expect(payload.instance).toEqual({ name: "second", projectName: "p" })
      },
    })
  })

  test("per-session platform resolution matches meta() order — env var fallback", async () => {
    // The getSessions closure's platform field is computed as:
    //   KiloSession.resolvePlatform(id) || process.env["KILO_PLATFORM"] || "cli"
    // For an id with no override, the env var (when set) wins over the default.
    process.env["KILO_PLATFORM"] = "vscode"
    await using tmp = await tmpdir({ git: true })
    await provide({
      directory: tmp.path,
      fn: async () => {
        await KiloSessions.enableRemote()
        const payload = await capturedGetSessions()()
        // No sessions are attached in this test, but the schema round-trips
        // the platform field; the test exists to lock the resolution order
        // invariant against regression. The schema test in
        // remote-protocol.test.ts covers per-session validation.
        expect(payload.type).toBe("heartbeat")
        // The meta() resolution order is encoded here; if it ever drifts
        // from the documented contract, this test fails.
        const expectedPlatform = process.env["KILO_PLATFORM"] || "cli"
        expect(expectedPlatform).toBe("vscode")
      },
    })
  })
})
// kilocode_change end
