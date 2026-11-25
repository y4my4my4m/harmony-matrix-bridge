import { join } from 'node:path'
import { parentPort, workerData, type MessagePort } from 'node:worker_threads'
import { homeserverFetch } from './guardedFetch.js'
import type { FromWorker, HostedWorkerData, ToWorker } from './hostedProtocol.js'
import { ManagedBridge } from './managed.js'

/** One community's bridge, in a thread of its own. `exit` ends the thread alone. */
export function runHosted(port: Pick<MessagePort, 'on' | 'postMessage'>, data: HostedWorkerData, exit: (code: number) => void): ManagedBridge {
  const say = (message: FromWorker) => port.postMessage(message)
  const label = `[${data.bridgeId.slice(0, 8)}]`
  const answers = new Map<number, (granted: boolean) => void>()
  let asked = 0
  const bridge = new ManagedBridge({
    kind: 'managed', harmonyUrl: data.harmony.apiBase, setupCode: null, dataDir: data.dataDir, listen: null, ignoredConfig: null,
    matrix: { kind: 'account', homeserverUrl: data.homeserverUrl, accessToken: data.accessToken },
  }, {
    version: data.version, timings: data.timings, matrixFetch: homeserverFetch(data.anyAddress),
    log: line => console.info(`${label} ${line}`), warn: line => console.warn(`${label} ${line}`),
    hosted: {
      harmony: data.harmony,
      claim: (homeserverUrl, userId) => new Promise(resolve => {
        const id = ++asked
        answers.set(id, resolve)
        say({ type: 'claim', id, homeserverUrl, userId })
      }),
      tokenHint: `Sign in with the account again in Harmony${data.publicUrl ? ` (${data.publicUrl})` : ''}: Server settings, Bridges, Matrix.`,
      refusedHint: 'The next reading of the host list brings a new one.',
    },
  })
  let brokenSince: number | null = null
  const health = () => {
    const status = bridge.status()
    say({ type: 'health', health: status })
    if (!status.problems?.includes('worker_stopped')) brokenSince = null
    else if (Date.now() - (brokenSince ??= Date.now()) >= data.brokenMs) exit(1)
  }
  const timer = setInterval(health, data.healthMs)
  let stopping = false
  port.on('message', (message: ToWorker) => {
    if (message.type === 'claimed') {
      answers.get(message.id)?.(message.granted)
      answers.delete(message.id)
    } else if (message.type === 'stop' && !stopping) {
      stopping = true
      clearInterval(timer)
      void bridge.stop().then(() => exit(0), () => exit(1))
    }
  })
  // A failed start ends the thread: the host starts it anew.
  void bridge.start().then(health, () => {
    clearInterval(timer)
    console.error(`${label} The bridge could not start; check the data directory`)
    exit(1)
  })
  return bridge
}

if (parentPort && (workerData as HostedWorkerData | null)?.bridgeId) runHosted(parentPort, workerData as HostedWorkerData, code => process.exit(code))

/** A hosted bridge's own folder. Kept when the bridge is gone. */
export function hostedDataDir(dataDir: string, bridgeId: string): string { return join(dataDir, 'hosted', bridgeId) }
