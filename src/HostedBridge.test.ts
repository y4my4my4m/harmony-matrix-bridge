import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import { createServer, type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostedBridge, type HostedBridgeOptions } from './HostedBridge.js'
import { runHosted } from './hostedWorker.js'
import { ManagedBridge } from './managed.js'
import type { FromWorker, HostedWorkerData, ToWorker } from './hostedProtocol.js'

const directory = mkdtempSync(join(tmpdir(), 'mxb-worker-'))
const bridges: HostedBridge[] = []
afterEach(async () => { await Promise.all(bridges.splice(0).map(bridge => bridge.stop())); vi.restoreAllMocks() })
process.on('exit', () => { rmSync(directory, { recursive: true, force: true }) })

const data: HostedWorkerData = { bridgeId: '11111111-1111-4111-8111-111111111111', harmony: { apiBase: 'http://127.0.0.1:1', gatewayUrl: 'ws://127.0.0.1:1/gateway', token: 'harmony_bot_secret' },
  homeserverUrl: 'https://matrix.test', accessToken: 'syt_secret', dataDir: join(directory, 'data'), version: 'test', anyAddress: false, publicUrl: null, healthMs: 20, brokenMs: 100 }
let serial = 0
/** A thread that runs `body` with the protocol of hostedWorker.ts. */
function thread(body: string, options: Partial<HostedBridgeOptions> = {}) {
  const path = join(directory, `worker${serial++}.mjs`)
  writeFileSync(path, `import { parentPort, workerData } from 'node:worker_threads'
    const health = setInterval(() => parentPort.postMessage({ type: 'health', health: { ready: true, pending: 1, failed: 2 } }), 10)
    parentPort.on('message', message => { if (message.type === 'stop') process.exit(0) })
    ${body}`)
  const lines: string[] = []
  const onEnded = vi.fn()
  const claim = vi.fn(() => true)
  const bridge = new HostedBridge({ workerUrl: pathToFileURL(path), data, claim, onEnded, log: line => lines.push(line), warn: line => lines.push(line),
    restart: { baseMs: 50, maxMs: 200, stableMs: 60_000 }, stopMs: 300, hangMs: 400, ...options })
  bridges.push(bridge)
  bridge.start()
  return { bridge, lines, onEnded, claim }
}

describe('a hosted bridge\'s thread', () => {
  it('reports, claims its account and stops when it is asked to', async () => {
    const { bridge, claim, onEnded, lines } = thread(`parentPort.postMessage({ type: 'claim', id: 7, homeserverUrl: 'https://matrix.test', userId: '@me:matrix.test' })
      parentPort.on('message', message => { if (message.type === 'claimed') parentPort.postMessage({ type: 'health', health: { ready: false, pending: message.id, failed: message.granted ? 1 : 0 } }), clearInterval(health) })`)
    await vi.waitFor(() => expect(bridge.health).toEqual({ ready: false, pending: 7, failed: 1 }), 3_000)
    expect(claim).toHaveBeenCalledExactlyOnceWith('https://matrix.test', '@me:matrix.test')
    await bridge.stop()
    expect(bridge.health).toBeNull()
    expect(onEnded).toHaveBeenCalledOnce()
    expect(lines).toEqual([])
  })
  it.each([['throws in a timer', 'setTimeout(() => { throw new TypeError("syt_secret") }, 30)', /TypeError at /], ['rejects a promise nobody waits for', 'Promise.reject(new Error("syt_secret"))', /Error at /],
    ['ends by itself', 'setTimeout(() => process.exit(3), 30)', /it ended/], ['cannot be loaded', 'throw new Error("syt_secret")', /Error at /]])('that %s starts again, later each time, and says where, not what', async (_name, body, reason) => {
    const { lines, onEnded } = thread(body)
    await vi.waitFor(() => expect(lines.length).toBeGreaterThanOrEqual(3), 5_000)
    expect(lines[0]).toMatch(/^\[11111111\] Bridge stopped by an error; restarting in 0 s\. /)
    expect(lines[0]).toMatch(reason)
    expect(lines.join()).not.toContain('secret')
    expect(onEnded.mock.calls.length).toBeGreaterThanOrEqual(3)
  })
  it('that loops is ended and starts again, beside one that works', async () => {
    const working = thread('')
    const { lines } = thread('setTimeout(() => { for (;;); }, 50)')
    await vi.waitFor(() => expect(lines[0]).toContain('it no longer responded'), 5_000)
    await vi.waitFor(() => expect(lines.length).toBeGreaterThanOrEqual(2), 5_000)
    expect(working.lines).toEqual([])
    expect(working.bridge.health).toMatchObject({ ready: true })
  })
  it('that runs out of memory ends alone', async () => {
    // Some 20 MB a second.
    const { lines } = thread('const kept = []; setInterval(() => { for (let i = 0; i < 2000; i++) kept.push({ i, text: "x" + i }) }, 10)', { heapMb: 16, hangMs: 30_000 })
    await vi.waitFor(() => expect(lines[0]).toContain('out of memory'), 15_000)
  }, 20_000)
  it('that does not stop is ended, and stays ended', async () => {
    const { bridge, lines } = thread('parentPort.removeAllListeners("message"); parentPort.on("message", () => {}); parentPort.ref()')
    await vi.waitFor(() => expect(bridge.health).not.toBeNull(), 3_000)
    await bridge.stop()
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(bridge.health).toBeNull()
    expect(lines).toEqual([])
  })
  it('can be started anew by its host', async () => {
    const { bridge, lines, onEnded } = thread('')
    await vi.waitFor(() => expect(bridge.health).not.toBeNull(), 3_000)
    bridge.end('Its account is the instance\'s')
    expect(onEnded).toHaveBeenCalledOnce()
    expect(lines).toEqual(['[11111111] Bridge stopped by an error; restarting in 0 s. Its account is the instance\'s'])
    await vi.waitFor(() => expect(bridge.health).not.toBeNull(), 3_000)
    expect(onEnded).toHaveBeenCalledOnce()
  })
})

describe('what runs in it', () => {
  function port() {
    const emitter = new EventEmitter()
    const sent: FromWorker[] = []
    return { on: emitter.on.bind(emitter) as never, postMessage: (message: FromWorker) => { sent.push(message) }, sent, say: (message: ToWorker) => emitter.emit('message', message) }
  }
  it('is a bridge with an account, reporting on and stopping', async () => {
    const lines: string[] = []
    for (const method of ['info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(line => { lines.push(String(line)) })
    const fake = port()
    const exit = vi.fn()
    runHosted(fake, data, exit)
    await vi.waitFor(() => expect(fake.sent.some(message => message.type === 'health')).toBe(true), 3_000)
    expect(fake.sent[0]).toMatchObject({ type: 'health', health: { ready: false, pending: 0 } })
    fake.say({ type: 'stop' })
    fake.say({ type: 'stop' })
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0), 10_000)
    expect(lines.every(line => line.startsWith('[11111111] '))).toBe(true)
    expect(lines.join()).not.toContain('secret')
  }, 15_000)
  it('asks its homeserver through the guard alone', async () => {
    for (const method of ['info', 'warn'] as const) vi.spyOn(console, method).mockImplementation(() => {})
    let connections = 0
    const server = createServer(socket => { connections++; socket.destroy() })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const homeserverUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
    for (const [anyAddress, reached] of [[false, false], [true, true]] as const) {
      connections = 0
      const fake = port()
      const exit = vi.fn()
      runHosted(fake, { ...data, homeserverUrl, anyAddress, dataDir: join(directory, `guard-${anyAddress}`), timings: { backoffMs: 20, matrixMs: 50 } }, exit)
      await new Promise(resolve => setTimeout(resolve, 600))
      expect(connections > 0).toBe(reached)
      fake.say({ type: 'stop' })
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), 10_000)
    }
    server.close()
  }, 25_000)
  it('ends when it could not write its database for a while, to start anew', async () => {
    for (const method of ['info', 'warn'] as const) vi.spyOn(console, method).mockImplementation(() => {})
    let problems: string[] = []
    vi.spyOn(ManagedBridge.prototype, 'status').mockImplementation(() => ({ ready: false, pending: 0, failed: 0, problems }))
    const fake = port()
    const exit = vi.fn()
    runHosted(fake, { ...data, dataDir: join(directory, 'broken') }, exit)
    for (const now of [['worker_stopped'], [], ['worker_stopped']]) {
      expect(exit).not.toHaveBeenCalled()
      problems = now
      await new Promise(resolve => setTimeout(resolve, 60))
    }
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    fake.say({ type: 'stop' })
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), 10_000)
  }, 15_000)
  it('ends when it cannot start', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.fn()
    writeFileSync(join(directory, 'file'), '')
    runHosted(port(), { ...data, dataDir: join(directory, 'file', 'inside') }, exit)
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(1))
    expect(error).toHaveBeenCalledExactlyOnceWith('[11111111] The bridge could not start; check the data directory')
  })
})
