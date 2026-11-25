import type { Server } from 'node:http'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { createAppService, createHealthServer, type ServiceStatus } from './AppService.js'
import type { StatusReport } from './BridgeApi.js'
import { botUserId } from './config.js'
import { CredentialsError, obtainCredentials, serviceTokens, writeRegistration, type ServiceTokens } from './credentials.js'
import { EndpointError, endpointsFor, probeEndpoints } from './endpoints.js'
import type { ManagedPlan } from './env.js'
import type { FetchImpl } from './http.js'
import { MatrixConnection } from './MatrixConnection.js'
import type { MatrixEvent } from './Relay.js'
import { RoomDirectory } from './Rooms.js'
import { SERVER_TIMINGS, ServerBridge, type HarmonyAccess, type ServerTimings } from './ServerBridge.js'
import { Store } from './Store.js'

/** The operator has to change something; printed as it is. */
export class FatalConfigError extends Error {}

export interface ManagedTimings extends ServerTimings { matrixMs: number; backoffMs: number }
export const MANAGED_TIMINGS: ManagedTimings = { ...SERVER_TIMINGS, matrixMs: 60_000, backoffMs: 5_000 }
const MAX_BACKOFF_MS = 5 * 60_000

export interface ManagedOptions {
  version: string
  log?: (line: string) => void
  warn?: (line: string) => void
  fetchImpl?: FetchImpl
  /** For requests to the homeserver; default `fetchImpl`. */
  matrixFetch?: FetchImpl
  timings?: Partial<ManagedTimings>
  /** Run by a bridge host: the gateway is known and no code is redeemed. */
  hosted?: { harmony: HarmonyAccess; claim: (homeserverUrl: string, userId: string) => Promise<boolean>; tokenHint: string; refusedHint: string }
}

/** A bridge its Harmony server configures: pairs, privacy and sender modes come from there, Matrix from the plan. */
export class ManagedBridge {
  private readonly timings: ManagedTimings
  private readonly log: (line: string) => void
  private readonly warn: (line: string) => void
  private store!: Store
  private server?: Server
  private tokens?: ServiceTokens
  private bridge?: ServerBridge
  private connection?: MatrixConnection
  private rooms?: RoomDirectory
  private stopped = false
  private followed = ''
  private readingRooms = false
  private roomTimer?: ReturnType<typeof setInterval>
  private readonly wakes = new Set<() => void>()

  constructor(private readonly plan: ManagedPlan, private readonly options: ManagedOptions) {
    this.timings = { ...MANAGED_TIMINGS, ...options.timings }
    this.log = options.log ?? (line => console.info(line))
    this.warn = options.warn ?? (line => console.warn(line))
  }

  /** Returns once the bridge holds its credentials; what comes after retries in the background. */
  async start(): Promise<void> {
    const { plan } = this
    if (plan.ignoredConfig) this.log('HARMONY_URL is set: config.json is not read')
    try {
      mkdirSync(plan.dataDir, { recursive: true, mode: 0o700 })
      this.store = new Store(join(plan.dataDir, 'bridge.sqlite'))
    } catch {
      throw new FatalConfigError(`${plan.dataDir} cannot be used. DATA_DIR must be a writable directory; with Docker, mount a volume at /data.`)
    }
    try {
      if (plan.matrix.kind === 'application_service') {
        this.tokens = serviceTokens(plan.matrix, plan.dataDir)
        if (writeRegistration(plan.matrix, this.tokens, plan.dataDir)) {
          this.log(`Wrote ${this.registrationPath()}: add it to your homeserver's application services (Synapse: app_service_config_files) and restart the homeserver. It holds secrets.`)
        }
      }
      await this.listen()
      const harmony = this.options.hosted?.harmony ?? await this.obtainHarmony()
      if (this.stopped) return
      this.connect(harmony)
    } catch (error) {
      await this.stop()
      if (error instanceof CredentialsError || error instanceof EndpointError) throw new FatalConfigError(error.message)
      throw error
    }
    this.roomTimer = setInterval(() => { void this.refreshRooms().catch(() => {}) }, this.timings.roomsMs)
    this.connection!.start()
    await this.bridge!.start()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    clearInterval(this.roomTimer)
    for (const wake of this.wakes) wake()
    const server = this.server
    const closed = server?.listening ? new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections() }) : undefined
    await Promise.all([closed, this.bridge?.stop(), this.connection?.stop()])
    this.store?.close()
  }

  private registrationPath(): string { return join(this.plan.dataDir, 'registration.json') }

  /** Where bot-gateway is, and the bridge's token for it. */
  private async obtainHarmony(): Promise<HarmonyAccess> {
    const { plan } = this
    const probed = await this.untilReachable('Cannot reach Harmony', () => probeEndpoints(plan.harmonyUrl, this.options.fetchImpl),
      error => error instanceof EndpointError && error.unreachable)
    const { credentials, source } = await this.untilReachable('Cannot redeem the setup code', () => obtainCredentials({
      harmonyUrl: plan.harmonyUrl, setupCode: plan.setupCode, dataDir: plan.dataDir, apiBase: probed.apiBase,
      fetchImpl: this.options.fetchImpl, warn: line => this.warn(line),
    }), error => error instanceof CredentialsError && error.kind === 'unreachable')
    this.log(source === 'redeemed' ? 'Setup code redeemed; HARMONY_SETUP_CODE is no longer needed' : 'Using the saved credentials')
    // A gateway address given directly wins over the public one Harmony returns, and https is never given up.
    const kept = probed.direct || (plan.harmonyUrl.startsWith('https:') && !(credentials.api_url.startsWith('https:') && credentials.gateway_url.startsWith('wss:')))
    const endpoints = kept ? probed : endpointsFor(credentials.api_url, false)
    return { apiBase: endpoints.apiBase, gatewayUrl: kept ? probed.gatewayUrl : credentials.gateway_url, token: credentials.harmony_token }
  }

  private sleep(delay: number): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.wakes.delete(done); resolve() }
      const timer = setTimeout(done, delay)
      this.wakes.add(done)
    })
  }

  private async untilReachable<T>(what: string, operation: () => Promise<T>, waits: (error: unknown) => boolean): Promise<T> {
    for (let delay = this.timings.backoffMs, told = false; ; delay = Math.min(MAX_BACKOFF_MS, delay * 2)) {
      try { return await operation() }
      catch (error) {
        if (this.stopped || !waits(error)) throw error
        if (!told) this.warn(`${what}; retrying`)
        told = true
        await this.sleep(delay)
        if (this.stopped) throw error
      }
    }
  }

  private async listen(): Promise<void> {
    const { matrix, listen } = this.plan
    if (!listen) return
    const server = matrix.kind === 'account' ? createHealthServer(() => this.status()) : createAppService({
      hsToken: this.tokens!.hsToken,
      botUserId: botUserId({ matrix }),
      ownsGhost: id => this.store.ownsGhost(id),
      acceptTransaction: (id, events) => this.acceptTransaction(id, events),
      status: () => this.status(),
      report: line => this.warn(line),
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      const failed = () => reject(new FatalConfigError(`Cannot listen on ${listen.host}:${listen.port}. Set LISTEN_HOST and LISTEN_PORT, or free the port.`))
      server.once('error', failed)
      server.listen(listen.port, listen.host, () => { server.off('error', failed); resolve() })
    })
  }

  /** Refused until the pairs are known: the homeserver keeps its events and asks again. */
  private acceptTransaction(id: string, events: MatrixEvent[]): boolean {
    if (!this.bridge?.isReceiving) throw new Error('Pairs are not known yet')
    return this.bridge.relay!.acceptTransaction(id, events)
  }

  private connect(harmony: HarmonyAccess): void {
    const { plan, options, store, timings } = this
    const { matrix } = plan
    const log = (line: string) => this.log(line)
    const warn = (line: string) => this.warn(line)
    const bridge = this.bridge = new ServerBridge({
      version: options.version, store, harmony, connection: matrix.kind, homeserver: matrix.homeserverUrl, fetchImpl: options.fetchImpl, timings, log, warn,
      refusedHint: options.hosted?.refusedHint ?? 'Make a new setup code in Harmony (Server settings, Bridges, Matrix) and set it as HARMONY_SETUP_CODE.',
      link: {
        get connected() { return connection.connected },
        get receiving() { return connection.receiving },
        problems: () => connection.problems(),
        rooms: () => this.rooms?.list() ?? [],
      },
      onPairs: () => this.pairsChanged(),
    })
    const connection: MatrixConnection = this.connection = new MatrixConnection({
      access: matrix.kind === 'account' ? matrix : { kind: matrix.kind, homeserverUrl: matrix.homeserverUrl, serverName: matrix.serverName,
        senderLocalpart: matrix.senderLocalpart, asToken: this.tokens!.asToken },
      store, accept: (userId, batch) => bridge.relay!.acceptSync(userId, batch), rooms: kept => bridge.pairs!.joinedRooms(kept),
      onMembership: (roomId, membership) => bridge.pairs!.noteMembership(roomId, membership),
      onIdentity: (client, identity) => {
        bridge.attach(client, identity)
        this.rooms = new RoomDirectory({ matrix: client, store, account: matrix.kind === 'account', paired: () => bridge.pairs!.pairs.map(pair => pair.matrixRoomId) })
      },
      onUsable: async () => {
        await bridge.begin()
        bridge.matrixUsable()
        if (bridge.isStarted) connection.startSync()
      },
      onState: () => bridge.statusSoon(),
      claim: options.hosted?.claim, tokenHint: options.hosted?.tokenHint,
      registrationHint: `add ${this.registrationPath()} to its application services and restart it`,
      fetchImpl: options.matrixFetch ?? options.fetchImpl, timings, log, warn,
    })
  }

  private pairsChanged(): void {
    const { bridge, connection } = this
    if (bridge?.isStarted && connection?.connected) connection.startSync()
    const followed = bridge?.pairs?.joinedRooms().join(' ') ?? ''
    if (followed === this.followed) return
    this.followed = followed
    connection?.roomsChanged()
  }

  refreshConfig(): Promise<void> { return this.bridge?.refreshConfig() ?? Promise.resolve() }

  private async refreshRooms(): Promise<void> {
    if (this.stopped || !this.rooms || !this.connection!.connected || this.readingRooms) return
    this.readingRooms = true
    try { await this.rooms.refresh() }
    finally { this.readingRooms = false }
    this.bridge!.roomsRead()
  }

  status(): ServiceStatus {
    const problems = this.bridge?.problems() ?? []
    return { ready: !this.stopped && (this.bridge?.isReady ?? false), ...this.store.counts(), problems: [...new Set(problems.map(problem => problem.code))] }
  }

  report(): StatusReport { return this.bridge!.report() }
  async sendStatus(): Promise<void> { await this.bridge?.sendStatus() }
}
