import type { HarmonyAccess } from './ServerBridge.js'
import type { ManagedTimings } from './managed.js'

/** workerData of a hosted bridge's thread. */
export interface HostedWorkerData {
  bridgeId: string
  harmony: HarmonyAccess
  homeserverUrl: string
  accessToken: string
  dataDir: string
  version: string
  /** Homeservers on private addresses too. */
  anyAddress: boolean
  publicUrl: string | null
  timings?: Partial<ManagedTimings>
  healthMs: number
  /** A bridge that cannot write its database is started anew after this long. */
  brokenMs: number
}
export interface HostedHealth { ready: boolean; pending: number; failed: number; problems?: string[] }

/** Host to thread. `claimed` answers one `claim`. */
export type ToWorker = { type: 'stop' } | { type: 'claimed'; id: number; granted: boolean }
/** Thread to host. `health` repeats every healthMs; the thread exits after `stop`. */
export type FromWorker = { type: 'health'; health: HostedHealth } | { type: 'claim'; id: number; homeserverUrl: string; userId: string }
