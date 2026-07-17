// kilocode_change - new file
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { KiloSessions } from "@/kilo-sessions/kilo-sessions"
import { context } from "@/project/instance-context"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Instance } from "@/kilocode/instance"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import os from "node:os"
import path from "node:path"

function truncate(value: string, max: number) {
  return value.length > max ? value.slice(0, max) : value
}

export const RemoteCommand = cmd({
  command: "remote",
  describe: "enable remote connection for real-time session relay",
  builder: (yargs) => yargs,
  handler: async () => {
    await bootstrap(process.cwd(), async () => {
      // kilocode_change start - K1 W1: advertise this instance on the relay
      // heartbeat so the cloud side can show it as a spawn-capable instance.
      // The KILO_REMOTE_ATTACH_SESSION env var is reserved for K2's spawned
      // children — children must never advertise themselves, so we gate on it
      // here even before K2 lands. K2's spawn path will set this var and
      // call `kilo remote`; this gate then keeps the child off the picker.
      if (!process.env["KILO_REMOTE_ATTACH_SESSION"]) {
        const directory = Instance.directory
        KiloSessions.setInstanceAdvertisement({
          name: truncate(os.hostname(), 64),
          projectName: truncate(path.basename(directory) || directory, 64),
          version: truncate(InstallationVersion, 32),
        })
      }
      // kilocode_change end

      await KiloSessions.enableRemote()
      console.log("Remote connection enabled.")

      const abort = new AbortController()
      const shutdown = async () => {
        try {
          KiloSessions.disableRemote()
          await InstanceRuntime.disposeInstance(context.use())
        } finally {
          abort.abort()
        }
      }
      process.on("SIGTERM", shutdown)
      process.on("SIGINT", shutdown)
      process.on("SIGHUP", shutdown)
      await new Promise((resolve) => abort.signal.addEventListener("abort", resolve))
    })
  },
})
