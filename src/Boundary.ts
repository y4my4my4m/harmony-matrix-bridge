import { AsyncLocalStorage } from 'node:async_hooks'
import { Worker } from 'node:worker_threads'

const running = new AsyncLocalStorage<string>()

/** Runs a bridge's work so that what it throws later, in a timer or a promise, is known to be its own. */
export function inside<T>(id: string, run: () => T): T { return running.run(id, run) }
/** Runs what is the host's own although a bridge caused it. */
export function outside<T>(run: () => T): T { return running.exit(run) }
export function runningBridge(): string | undefined { return running.getStore() }

/** Where an error arose, without its message: that may hold what people wrote, or a token. */
export function errorPlace(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error'
  const frames = (error.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 4).map(line => line.trim())
  return [error.name, ...frames].join(' ')
}

/**
 * An error nothing caught ends the bridge it arose in, and only that one. One that belongs to no
 * bridge ends the process, as without this.
 */
export function guardProcess(crashed: (id: string, error: unknown) => boolean, report: (line: string) => void, exit: (code: number) => void = code => process.exit(code)): () => void {
  const caught = (error: unknown) => {
    const id = runningBridge()
    if (id !== undefined && crashed(id, error)) return
    report(`The bridge host stops after an error: ${errorPlace(error)}`)
    exit(1)
  }
  process.on('uncaughtException', caught)
  process.on('unhandledRejection', caught)
  return () => {
    process.off('uncaughtException', caught)
    process.off('unhandledRejection', caught)
  }
}

const WATCHER = `
const { workerData: { beat, stuckMs, line } } = require('node:worker_threads')
const { writeSync } = require('node:fs')
const pause = new Int32Array(new SharedArrayBuffer(4))
const step = Math.max(10, stuckMs / 20)
let last = -1, still = 0
for (;;) {
  Atomics.wait(pause, 0, 0, step)
  const now = Atomics.load(beat, 0)
  still = now === last ? still + step : 0
  last = now
  if (still < stuckMs) continue
  try { writeSync(2, line + '\\n') } catch {}
  process.kill(process.pid, 'SIGKILL')
}
`

/**
 * Ends a process whose event loop has stood still for `stuckMs`; whatever runs it starts it again.
 * Counts the watcher's own waits, not the clock: a machine that slept is not stuck.
 */
export function watchEventLoop(stuckMs = 120_000): () => void {
  const beat = new Int32Array(new SharedArrayBuffer(4))
  const timer = setInterval(() => { Atomics.add(beat, 0, 1) }, Math.max(5, stuckMs / 100))
  timer.unref()
  const watcher = new Worker(WATCHER, { eval: true, execArgv: [], workerData: { beat, stuckMs, line: 'The bridge host no longer responds; ending it' },
    resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 2 } })
  watcher.unref()
  watcher.on('error', () => {})
  return () => {
    clearInterval(timer)
    void watcher.terminate()
  }
}
