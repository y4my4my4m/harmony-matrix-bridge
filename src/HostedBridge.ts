import { Worker } from 'node:worker_threads'
import { errorPlace } from './Boundary.js'
import type { FromWorker, HostedHealth, HostedWorkerData, ToWorker } from './hostedProtocol.js'

export interface HostedBridgeOptions {
  workerUrl: URL
  data: HostedWorkerData
  /** Whether the account is this bridge's alone. */
  claim: (homeserverUrl: string, userId: string) => boolean
  /** The thread ended: its account is free. */
  onEnded: () => void
  log: (line: string) => void
  warn: (line: string) => void
  /** V8 old generation of the thread, MB. Past it V8 ends the thread, not the process. */
  heapMb?: number
  /** Wait before a restart: doubles up to maxMs, and starts over after a run of stableMs. */
  restart?: { baseMs: number; maxMs: number; stableMs: number }
  /** `stop` is answered within this, or the thread is ended. */
  stopMs?: number
  /** No sign of life for this long: the thread's event loop is blocked. */
  hangMs?: number
}

/** One community's bridge in a worker thread. One that throws, loops or runs out of memory ends alone and starts again. */
export class HostedBridge {
  private worker?: Worker
  private stopped = false
  private restarts = 0
  private spawnedAt = 0
  private heardAt = 0
  private timer?: ReturnType<typeof setTimeout>
  private watchdog?: ReturnType<typeof setInterval>
  private last: HostedHealth | null = null
  private readonly restart: { baseMs: number; maxMs: number; stableMs: number }
  private readonly hangMs: number

  constructor(private readonly options: HostedBridgeOptions) {
    this.restart = options.restart ?? { baseMs: 5_000, maxMs: 5 * 60_000, stableMs: 10 * 60_000 }
    this.hangMs = options.hangMs ?? 120_000
  }

  /** What the thread said last; null while there is none. */
  get health(): HostedHealth | null { return this.worker ? this.last : null }
  private get label(): string { return `[${this.options.data.bridgeId.slice(0, 8)}]` }

  start(): void {
    this.watchdog = setInterval(() => {
      if (this.worker && Date.now() - this.heardAt > this.hangMs) this.end('it no longer responded')
    }, Math.max(10, this.hangMs / 10))
    this.watchdog.unref()
    this.spawn()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    clearInterval(this.watchdog)
    const { worker } = this
    if (!worker) return
    const ended = new Promise<void>(resolve => { worker.once('exit', () => resolve()) })
    worker.postMessage({ type: 'stop' } satisfies ToWorker)
    const late = setTimeout(() => { void worker.terminate() }, this.options.stopMs ?? 8_000)
    await ended
    clearTimeout(late)
  }

  /** Starts the thread anew, as after an error. */
  end(reason: string): void {
    const { worker } = this
    if (!worker) return
    this.ended(worker, reason)
    void worker.terminate()
  }

  private spawn(): void {
    if (this.stopped) return
    this.spawnedAt = this.heardAt = Date.now()
    this.last = null
    let worker: Worker
    try { worker = new Worker(this.options.workerUrl, { workerData: this.options.data, resourceLimits: { maxOldGenerationSizeMb: this.options.heapMb ?? 192 } }) }
    catch (error) { this.again(errorPlace(error)); return }
    this.worker = worker
    let failure: string | null = null
    worker.on('message', (message: FromWorker) => {
      if (this.worker !== worker) return
      this.heardAt = Date.now()
      if (message.type === 'health') this.last = message.health
      else worker.postMessage({ type: 'claimed', id: message.id, granted: this.options.claim(message.homeserverUrl, message.userId) } satisfies ToWorker)
    })
    worker.on('error', error => {
      failure = (error as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'out of memory' : errorPlace(error)
    })
    worker.on('exit', () => this.ended(worker, failure ?? 'it ended'))
  }

  private ended(worker: Worker, reason: string): void {
    if (this.worker !== worker) return
    this.worker = undefined
    this.options.onEnded()
    if (!this.stopped) this.again(reason)
  }

  private again(reason: string): void {
    if (Date.now() - this.spawnedAt >= this.restart.stableMs) this.restarts = 0
    const delay = Math.min(this.restart.maxMs, this.restart.baseMs * 2 ** Math.min(this.restarts++, 10))
    this.options.warn(`${this.label} Bridge stopped by an error; restarting in ${Math.round(delay / 1000)} s. ${reason}`)
    this.timer = setTimeout(() => this.spawn(), delay)
  }
}
