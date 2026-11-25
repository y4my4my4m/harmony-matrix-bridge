import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { boundedServer } from './AppService.js'
import { errorPlace } from './Boundary.js'
import { EndpointError, probeEndpoints } from './endpoints.js'
import type { HostPlan } from './env.js'
import { HostApi, type HostedEntry, type HostList, type HostStatus, type InstanceAccess } from './HostApi.js'
import { HostedBridge, type HostedBridgeOptions } from './HostedBridge.js'
import type { HostedWorkerData } from './hostedProtocol.js'
import { HttpError, type FetchImpl } from './http.js'
import { INSTANCE_TIMINGS, InstanceHost, type InstanceTimings } from './InstanceHost.js'
import { FatalConfigError, MANAGED_TIMINGS } from './managed.js'

export interface HostTimings extends InstanceTimings { pollMs: number; hostStatusMs: number; healthyMs: number; hostedHealthMs: number }
const TIMINGS: HostTimings = { ...MANAGED_TIMINGS, ...INSTANCE_TIMINGS, pollMs: 60_000, hostStatusMs: 30_000, healthyMs: 5 * 60_000, hostedHealthMs: 10_000 }

export interface BridgeHostOptions {
  version: string
  log?: (line: string) => void
  warn?: (line: string) => void
  fetchImpl?: FetchImpl
  timings?: Partial<HostTimings>
  /** The thread of a hosted bridge. */
  workerUrl?: URL
  hosted?: Pick<HostedBridgeOptions, 'restart' | 'stopMs' | 'hangMs' | 'heapMb'>
}

const BROKEN_MS = 60_000

interface Hosted { fingerprint: string; bridge: HostedBridge }

/** Tokens do not leave this hash. */
function fingerprint(...values: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex')
}

/** Every bridge an instance runs: communities' own accounts, and the instance's one connection. Harmony says which. */
export class BridgeHost {
  private readonly timings: HostTimings
  private readonly log: (line: string) => void
  private readonly warn: (line: string) => void
  private server?: Server
  private api?: HostApi
  private endpoints?: { apiBase: string; gatewayUrl: string }
  private readonly hosted = new Map<string, Hosted>()
  private readonly stopping = new Map<string, Promise<void>>()
  private instance?: { fingerprint: string; host: InstanceHost }
  /** Accounts in use: a homeserver and a user on it, and the bridge. */
  private readonly claims = new Map<string, string>()
  private stopped = false
  private polledAt = 0
  private polling?: Promise<void>
  private pollAgain = false
  private pollTimer?: ReturnType<typeof setTimeout>
  private statusTimer?: ReturnType<typeof setInterval>
  private statusSoonTimer?: ReturnType<typeof setTimeout>
  private told = ''
  private delay: number
  private instanceFailed = false

  constructor(private readonly plan: HostPlan, private readonly options: BridgeHostOptions) {
    this.timings = { ...TIMINGS, ...options.timings }
    this.delay = this.timings.backoffMs
    this.log = options.log ?? (line => console.info(line))
    this.warn = options.warn ?? (line => console.warn(line))
  }

  /** Returns once it listens; Harmony is asked from then on, however long it takes to answer. */
  async start(): Promise<void> {
    const { plan } = this
    try { mkdirSync(join(plan.dataDir, 'hosted'), { recursive: true, mode: 0o700 }) }
    catch { throw new FatalConfigError(`${plan.dataDir} cannot be used. DATA_DIR must be a writable directory; with Docker, mount a volume at /data.`) }
    const server = this.server = boundedServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0]
      if (path !== '/health' && this.instance?.host.requests) return this.instance.host.requests(req, res)
      const answer = path === '/health' && req.method === 'GET' ? this.status() : null
      // A homeserver keeps its events and asks again.
      const code = answer ? answer.ready ? 200 : 503 : path.startsWith('/_matrix/app/') ? 503 : 404
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(answer ?? { error: code === 503 ? 'Not running' : 'Not found' }))
    })
    await new Promise<void>((resolve, reject) => {
      const failed = () => reject(new FatalConfigError(`Cannot listen on ${plan.listen.host}:${plan.listen.port}. Set LISTEN_HOST and LISTEN_PORT, or free the port.`))
      server.once('error', failed)
      server.listen(plan.listen.port, plan.listen.host, () => { server.off('error', failed); resolve() })
    })
    this.statusTimer = setInterval(() => { void this.sendStatus() }, this.timings.hostStatusMs)
    await this.poll()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    clearTimeout(this.pollTimer)
    clearInterval(this.statusTimer)
    clearTimeout(this.statusSoonTimer)
    const { server } = this
    const closed = server?.listening ? new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections() }) : undefined
    await this.polling?.catch(() => {})
    await Promise.all([closed, this.instance?.host.stop(), ...[...this.hosted.values()].map(({ bridge }) => bridge.stop()), ...this.stopping.values()])
  }

  /** An error of one of the instance's bridges that nothing caught. Those of a connection that stopped are over. */
  crashed(id: string, error: unknown): boolean { return this.instance?.host.crashed(id, error) ?? true }

  status(): { ready: boolean; mode: 'host'; hosted: number; hosted_ready: number; instance: { ready: boolean; problems: string[] } | null } {
    const instance = this.instance?.host.status()
    const bridges = [...this.hosted.values()]
    return { ready: !this.stopped && this.polledAt > 0 && Date.now() - this.polledAt < this.timings.healthyMs, mode: 'host', hosted: bridges.length,
      hosted_ready: bridges.filter(({ bridge }) => bridge.health?.ready).length,
      instance: instance ? { ready: instance.ready, problems: instance.problems.map(problem => problem.code) } : null }
  }

  /** One reading of the list at a time; a request during one is answered by one more. */
  poll(): Promise<void> {
    if (this.polling) { this.pollAgain = true; return this.polling }
    clearTimeout(this.pollTimer)
    this.polling = (async () => {
      do { this.pollAgain = false; await this.read().catch(error => this.warn(`The bridge list could not be followed; trying again. ${errorPlace(error)}`)) } while (this.pollAgain && !this.stopped)
    })().finally(() => {
      this.polling = undefined
      if (!this.stopped) this.pollTimer = setTimeout(() => { void this.poll() }, this.polledAt ? this.timings.pollMs : this.delay)
      if (!this.polledAt) this.delay = Math.min(this.timings.pollMs, this.delay * 2)
    })
    return this.polling
  }

  private async read(): Promise<void> {
    if (this.stopped) return
    let list: HostList
    try {
      if (!this.endpoints) {
        const { apiBase, gatewayUrl } = await probeEndpoints(this.plan.harmonyUrl, this.options.fetchImpl)
        this.endpoints = { apiBase, gatewayUrl }
        this.api = new HostApi(apiBase, this.plan.secret, this.options.fetchImpl)
      }
      list = await this.api!.list()
    } catch (error) {
      const status = error instanceof HttpError ? error.status : undefined
      // What runs goes on: nothing was said about it.
      this.tell(status === 401 ? 'Harmony refuses BRIDGE_HOST_SECRET: it must equal MATRIX_BRIDGE_HOST_SECRET of its bot gateway'
        : status === 404 ? 'Harmony hosts no Matrix bridges: MATRIX_BRIDGE_HOST_SECRET is not set on its bot gateway, or it is older than 1.9.9'
        : error instanceof EndpointError && !error.unreachable ? error.message : 'Cannot read the bridge list from Harmony; retrying')
      return
    }
    if (this.stopped) return
    if (this.told || !this.polledAt) this.log(`Bridge list read: ${list.hosted.length} hosted, ${list.instance ? `${list.instance.bridges.length} on the instance's connection` : 'no instance connection'}`)
    this.told = ''
    if (!this.polledAt) this.statusSoon()
    this.polledAt = Date.now()
    this.applyHosted(list.hosted)
    await this.applyInstance(list.instance)
  }

  private tell(line: string): void {
    if (line === this.told) return
    this.told = line
    this.warn(line)
  }

  // --- Communities' own accounts

  private applyHosted(entries: HostedEntry[]): void {
    const wanted = new Map(entries.map(entry => [entry.bridge_id, entry]))
    for (const [id, running] of this.hosted) {
      const entry = wanted.get(id)
      if (entry && this.hostedFingerprint(entry) === running.fingerprint) continue
      this.log(entry ? `[${id.slice(0, 8)}] Credentials changed; restarting` : `[${id.slice(0, 8)}] Bridge no longer listed; stopping`)
      this.hosted.delete(id)
      const stopping = running.bridge.stop().finally(() => { if (this.stopping.get(id) === stopping) this.stopping.delete(id) })
      this.stopping.set(id, stopping)
    }
    for (const [id, entry] of wanted) {
      if (this.hosted.has(id)) continue
      const bridge = new HostedBridge({ workerUrl: this.options.workerUrl ?? new URL('./hostedWorker.js', import.meta.url), data: this.workerData(entry),
        claim: (homeserverUrl, userId) => this.claim(id, homeserverUrl, userId), onEnded: () => this.release(id), log: this.log, warn: this.warn, ...this.options.hosted })
      const running: Hosted = { fingerprint: this.hostedFingerprint(entry), bridge }
      this.hosted.set(id, running)
      // Its database is free once the one before it has stopped.
      const before = this.stopping.get(id)
      if (before) void before.then(() => { if (!this.stopped && this.hosted.get(id) === running) bridge.start() })
      else bridge.start()
      this.log(`[${id.slice(0, 8)}] Bridge starting`)
    }
  }

  private hostedFingerprint(entry: HostedEntry): string { return fingerprint(entry.harmony_token, entry.homeserver_url, entry.access_token) }

  private workerData(entry: HostedEntry): HostedWorkerData {
    return { bridgeId: entry.bridge_id, harmony: { ...this.endpoints!, token: entry.harmony_token }, homeserverUrl: entry.homeserver_url, accessToken: entry.access_token,
      dataDir: join(this.plan.dataDir, 'hosted', entry.bridge_id), version: this.options.version, anyAddress: this.plan.anyAddress, publicUrl: this.plan.publicUrl,
      timings: this.options.timings, healthMs: this.timings.hostedHealthMs, brokenMs: BROKEN_MS }
  }

  /** One bridge per account. The homeserver is part of it: one could name any user as its own. */
  private claim(owner: string, homeserverUrl: string, userId: string): boolean {
    let origin: string
    try { origin = new URL(homeserverUrl).origin } catch { return false }
    const key = `${origin} ${userId}`
    const holder = this.claims.get(key)
    if (holder !== undefined && holder !== owner) {
      if (owner !== INSTANCE) return false
      // The instance's own account is its own.
      this.claims.set(key, owner)
      this.hosted.get(holder)?.bridge.end('Its account is the instance\'s')
      return true
    }
    this.release(owner)
    this.claims.set(key, owner)
    return true
  }

  private release(owner: string): void {
    for (const [key, holder] of this.claims) if (holder === owner) this.claims.delete(key)
  }

  // --- The instance's connection

  private async applyInstance(instance: HostList['instance']): Promise<void> {
    const wanted = instance ? fingerprint(instance.access) : null
    if (this.instance && this.instance.fingerprint !== wanted) {
      this.log(instance ? 'The instance\'s connection changed; restarting it' : 'The instance\'s connection is turned off; stopping it')
      const { host } = this.instance
      this.instance = undefined
      await host.stop()
      this.release(INSTANCE)
      this.statusSoon()
      if (this.stopped) return
    }
    if (!instance) { this.instanceFailed = false; return }
    if (!this.instance) {
      let host: InstanceHost
      try { host = this.createInstance(instance.access) }
      catch {
        if (!this.instanceFailed) this.warn('The instance\'s connection could not start: DATA_DIR cannot be written. Trying again')
        this.instanceFailed = true
        return
      }
      this.instanceFailed = false
      this.instance = { fingerprint: wanted!, host }
      host.start()
    }
    this.instance.host.apply(instance.bridges)
  }

  private createInstance(access: InstanceAccess): InstanceHost {
    const labelled = (line: string) => line.startsWith('[') ? line : `[instance] ${line}`
    return new InstanceHost({ dataDir: join(this.plan.dataDir, 'instance'), version: this.options.version, access, endpoints: this.endpoints!, api: this.api!, publicUrl: this.plan.publicUrl,
      timings: this.timings, fetchImpl: this.options.fetchImpl, claim: (homeserverUrl, userId) => { this.claim(INSTANCE, homeserverUrl, userId) },
      onUnknownBridge: () => { void this.poll() }, onState: () => this.statusSoon(), log: line => this.log(labelled(line)), warn: line => this.warn(labelled(line)) })
  }

  report(): HostStatus {
    const failed = { ready: false, user_id: null, server_name: null, problems: [{ code: 'worker_stopped' }] }
    return { version: this.options.version, instance: this.instance?.host.status() ?? (this.instanceFailed ? failed : null), hosted: this.hosted.size }
  }

  /** An administrator looks at the panel right after a change. */
  private statusSoon(): void {
    if (this.stopped || this.statusSoonTimer) return
    this.statusSoonTimer = setTimeout(() => {
      this.statusSoonTimer = undefined
      void this.sendStatus()
    }, this.timings.statusSoonMs)
  }

  async sendStatus(): Promise<void> {
    if (this.stopped || !this.api || !this.polledAt) return
    // Reading the list reports an unreachable or refusing Harmony.
    try { await this.api.status(this.report()) } catch { /* Sent again in half a minute. */ }
  }
}

const INSTANCE = 'instance'
