import { BridgeApi, type ManagedConfig, type Problem, type StatusReport } from './BridgeApi.js'
import { botUserId, type LivePair, type MatrixIdentity, type RelaySettings } from './config.js'
import type { GhostRegistry } from './Ghosts.js'
import { HarmonyClient } from './HarmonyClient.js'
import { HttpError, type FetchImpl } from './http.js'
import type { MatrixClient } from './MatrixClient.js'
import { PairManager } from './Pairs.js'
import { PrivacyDesk } from './Privacy.js'
import { Relay } from './Relay.js'
import type { Store } from './Store.js'

export interface HarmonyAccess { apiBase: string; gatewayUrl: string; token: string }
export interface ServerTimings { configMs: number; configSoonMs: number; statusMs: number; statusSoonMs: number; roomsMs: number; memberFrameMs: number }
export const SERVER_TIMINGS: ServerTimings = { configMs: 60_000, configSoonMs: 250, statusMs: 30_000, statusSoonMs: 2_000, roomsMs: 15_000,
  // Each member frame costs bot-gateway a lookup per channel.
  memberFrameMs: 15_000 }

/** The Matrix connection as one server's bridge sees it. */
export interface MatrixLink {
  readonly connected: boolean
  /** Connected, and events arrive. */
  readonly receiving: boolean
  problems(): Problem[]
  /** The rooms a manager sees. */
  rooms(): StatusReport['rooms']
}

export interface ServerBridgeOptions {
  version: string
  store: Store
  harmony: HarmonyAccess
  connection: StatusReport['connection']
  /** As the status report names it. */
  readonly homeserver: string
  link: MatrixLink
  fetchImpl?: FetchImpl
  timings: ServerTimings
  log: (line: string) => void
  warn: (line: string) => void
  /** The configuration was read, or a pair's state changed. */
  onPairs?: () => void
  /** What an operator does about a token Harmony refuses. */
  refusedHint: string
  /** Rooms are linked by codes alone: a pair no room is bound to is left out. */
  linkedOnly?: boolean
  /** Shared with other bridges on the connection, which then are not this one's to clean up. */
  ghosts?: GhostRegistry
  ownsRoom?: (roomId: string) => boolean
}

/** One Harmony server's bridge: its gateway connection, pairs, privacy and relay. Matrix belongs to its owner. */
export class ServerBridge {
  relay?: Relay
  pairs?: PairManager
  config?: ManagedConfig
  /** When the configuration was last read, epoch ms. */
  configAt = 0
  private readonly api: BridgeApi
  private readonly harmony: HarmonyClient
  private readonly privacy: PrivacyDesk
  private identity?: MatrixIdentity
  private started = false
  private stopped = false
  private applied = false
  private harmonyConnected = false
  private harmonyProblem: 'harmony_auth_failed' | 'harmony_unreachable' | null = null
  private harmonyErrorTold = false
  private storageFailed = false
  private refreshing?: Promise<void>
  private again = false
  private readonly timers = new Set<ReturnType<typeof setInterval>>()
  private configSoon?: ReturnType<typeof setTimeout>
  private statusSoonTimer?: ReturnType<typeof setTimeout>
  private reportedRooms = ''

  constructor(private readonly options: ServerBridgeOptions) {
    const { harmony: access, fetchImpl, warn, log } = options
    this.api = new BridgeApi(access.apiBase, access.token, fetchImpl)
    this.privacy = new PrivacyDesk(this.api, { oneServer: true, onChange: () => this.relay?.requestMemberSync() })
    const harmony = this.harmony = new HarmonyClient({ apiUrl: access.apiBase, gatewayUrl: access.gatewayUrl, token: access.token, fetchImpl, memberFrameMs: options.timings.memberFrameMs })
    harmony.on('ready', () => {
      this.harmonyConnected = true
      this.harmonyErrorTold = false
      this.relay?.requestMemberSync()
      this.refreshConfigSoon()
      this.statusSoon()
      log('Harmony gateway connected')
    })
    harmony.on('disconnected', () => { this.harmonyConnected = false; this.statusSoon() })
    harmony.on('error', () => {
      if (!this.harmonyErrorTold) warn('Harmony connection error; check connectivity and bot credentials')
      this.harmonyErrorTold = true
    })
    harmony.on('refused', () => { this.setHarmony('harmony_auth_failed') })
    harmony.on('config', (data: { bridge_id?: unknown } | undefined) => {
      if (data?.bridge_id === undefined || data.bridge_id === this.config?.bridgeId) this.refreshConfigSoon()
    })
    harmony.on('member', userId => { this.relay?.noteServerMember(userId) })
    harmony.on('message', message => {
      try { this.relay?.acceptHarmonyMessage(message) }
      catch { warn('Could not enqueue Harmony message; check local storage and queue capacity') }
    })
  }

  /** Which Matrix user the bridge is. Once. */
  attach(matrix: MatrixClient, identity: MatrixIdentity): void {
    const { options, harmony } = this
    const { store } = options
    const account = identity.userId !== undefined
    // Read live: the relay looks at `pairs` on every event and job.
    const settings: RelaySettings = { harmony: {}, matrix: identity, get pairs(): LivePair[] { return pairs.pairs } }
    const pairs: PairManager = new PairManager({
      harmony, matrix, store, ghosts: !account,
      onPairs: () => this.pairsChanged(),
      onReady: channelId => { relay.requestMemberSync(channelId); options.log('Pair ready') },
      onRemoved: channelId => {
        harmony.forgetMatrixMembers(channelId)
        relay.forgetChannel(channelId)
      },
      onStale: () => this.refreshConfigSoon(),
      report: line => options.warn(line),
    })
    const relay: Relay = new Relay(settings, store, harmony, matrix, line => options.warn(line), {
      privacy: this.privacy,
      avatarScope: () => 'server',
      keepsGhosts: roomId => pairs.keepsGhosts(roomId),
      onGhosts: (channelId, usable) => pairs.noteGhosts(channelId, usable),
      onEncrypted: roomId => pairs.noteEncrypted(roomId),
      onRefused: channelId => pairs.recheck(channelId),
      ...(options.ghosts ? { ghosts: options.ghosts, cleansGhosts: false, ownsRoom: options.ownsRoom }
        : { onMembership: (roomId: string, membership: string) => pairs.noteMembership(roomId, membership) }),
    })
    this.identity = identity
    this.relay = relay
    this.pairs = pairs
  }

  /** Reads the configuration, and goes on doing so. */
  async start(): Promise<void> {
    const { timings } = this.options
    this.every(timings.configMs, () => this.refreshConfig())
    this.every(timings.statusMs, () => this.sendStatus())
    await this.refreshConfig()
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const timer of this.timers) clearInterval(timer)
    clearTimeout(this.configSoon)
    clearTimeout(this.statusSoonTimer)
    this.harmony.stop()
    this.pairs?.stop()
    await Promise.all([this.relay?.stop(), this.refreshing?.catch(() => {})])
  }

  private every(delay: number, run: () => Promise<unknown>): void {
    this.timers.add(setInterval(() => { void run().catch(() => {}) }, delay))
  }

  /** The relay runs. */
  get isStarted(): boolean { return this.started }
  /** Events can be taken: the pairs are known. */
  get isReceiving(): boolean { return this.applied && !this.stopped }
  get isHealthy(): boolean { return !this.storageFailed && (this.relay?.isHealthy ?? true) }
  get isReady(): boolean {
    return !this.stopped && this.started && this.isHealthy && this.harmonyConnected && this.harmonyProblem === null && this.options.link.receiving
  }

  private pairsChanged(): void {
    const { relay, pairs } = this
    if (!relay || !pairs) return
    for (const pair of pairs.pairs) if (pair.state === 'error') this.harmony.publishMatrixMembers(pair.harmonyChannelId, [])
    relay.requestGhostCleanup()
    relay.wake()
    this.options.onPairs?.()
    this.statusSoon()
  }

  /** Configuration and identity are both needed; whichever comes second starts the relay. */
  async begin(): Promise<void> {
    const { relay, config } = this
    if (!relay || !config || this.started || this.stopped) return
    // The worker fails the queued messages of pairs it does not know.
    if (!this.applyPairs()) return
    this.started = true
    // Before anything is relayed. An unread list does not hold the bridge back: Harmony refuses an opted-out author.
    await this.loadOptOuts()
    if (this.stopped) return
    this.harmony.start()
    relay.start()
    relay.requestGhostCleanup()
    if (this.options.link.connected) this.matrixUsable()
  }

  /** A failed write leaves the pairs as they were; the next read tries again. */
  private applyPairs(): boolean {
    try {
      this.pairs!.apply(this.config!.pairs)
      this.storageFailed = false
      this.applied = true
    } catch {
      this.storageFailed = true
      this.options.warn('Local storage failed; check the disk and restart the bridge')
    }
    return !this.storageFailed
  }

  /** The homeserver takes the bridge. */
  matrixUsable(): void {
    if (this.started && !this.stopped) this.pairs!.start()
  }

  refreshConfigSoon(): void {
    if (this.stopped) return
    clearTimeout(this.configSoon)
    this.configSoon = setTimeout(() => { void this.refreshConfig().catch(() => {}) }, this.options.timings.configSoonMs)
  }

  /** One read at a time; a request during one is answered by one more. */
  refreshConfig(): Promise<void> {
    if (this.refreshing) { this.again = true; return this.refreshing }
    this.refreshing = (async () => {
      do { this.again = false; await this.readConfig() } while (this.again && !this.stopped)
    })().finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  private async readConfig(): Promise<void> {
    if (this.stopped) return
    const asked = Date.now()
    let config: ManagedConfig
    try { config = await this.api.config() }
    catch (error) {
      const refused = error instanceof HttpError && !error.transient && (error.status === 401 || error.status === 403 || error.status === 404)
      this.setHarmony(refused ? 'harmony_auth_failed' : 'harmony_unreachable')
      return
    }
    if (this.stopped) return
    this.setHarmony(null)
    if (this.options.linkedOnly) config.pairs = config.pairs.filter(pair => pair.roomId !== null)
    const before = this.config
    const changed = this.storageFailed || JSON.stringify(before?.pairs) !== JSON.stringify(config.pairs)
    this.config = config
    if (!this.started) await this.begin()
    else {
      if (changed) this.applyPairs()
      // Opt-outs of Harmony members show in nothing else.
      if (before && before.updatedAt !== config.updatedAt) this.relay!.noteConfiguration()
      await this.loadOptOuts()
      // The gateway refused the token earlier and takes it now.
      if (!this.stopped && !this.harmony.isRunning) this.harmony.start()
    }
    this.configAt = asked
    if (!before || changed) this.options.log(`Configuration read: ${config.pairs.length} pair(s)`)
    this.options.onPairs?.()
    this.statusSoon()
  }

  private setHarmony(problem: ServerBridge['harmonyProblem']): void {
    if (problem === this.harmonyProblem) return
    this.harmonyProblem = problem
    if (problem === 'harmony_auth_failed') this.options.warn(`Harmony refuses the bridge's credentials. ${this.options.refusedHint}`)
    else if (problem) this.options.warn('Cannot read the bridge configuration from Harmony; retrying')
    this.statusSoon()
  }

  private async loadOptOuts(): Promise<void> {
    if (!this.config || this.config.privacyVersion === null) return
    try { await this.privacy.load('', this.config.privacyVersion) }
    catch { this.options.warn('Could not read the opt-out list; trying again at the next configuration read') }
  }

  /** The rooms the owner lists may have changed. */
  roomsRead(): void {
    if (this.isReady && JSON.stringify(this.options.link.rooms()) !== this.reportedRooms) this.statusSoon()
  }

  problems(): Problem[] {
    const problems: Problem[] = []
    if (this.harmonyProblem) problems.push({ code: this.harmonyProblem })
    problems.push(...this.options.link.problems())
    if (!this.isHealthy) problems.push({ code: 'worker_stopped', detail: 'The bridge could not write its local storage. Check its disk, then restart it.' })
    if (this.pairs) problems.push(...this.pairs.problems())
    return distinct(problems)
  }

  report(): StatusReport {
    const ready = this.isReady
    return {
      version: this.options.version,
      connection: this.options.connection,
      ready,
      user_id: this.identity ? botUserId({ matrix: this.identity }) : null,
      homeserver: this.options.homeserver,
      server_name: this.identity?.serverName ?? null,
      ...this.options.store.counts(),
      rooms: ready ? this.options.link.rooms() : [],
      pairs: this.pairs?.reports() ?? [],
      problems: this.problems(),
    }
  }

  statusSoon(): void {
    if (this.stopped || this.statusSoonTimer) return
    this.statusSoonTimer = setTimeout(() => {
      this.statusSoonTimer = undefined
      void this.sendStatus()
    }, this.options.timings.statusSoonMs)
  }

  async sendStatus(): Promise<void> {
    if (this.stopped) return
    try {
      const report = this.report()
      this.reportedRooms = JSON.stringify(report.rooms)
      await this.api.status(report)
    } catch { /* The configuration read reports an unreachable or refusing Harmony. */ }
  }
}

export function distinct(problems: Problem[]): Problem[] {
  const seen = new Set<string>()
  return problems.filter(problem => {
    const key = `${problem.code} ${problem.detail ?? ''}`
    return seen.has(key) ? false : seen.add(key)
  })
}
