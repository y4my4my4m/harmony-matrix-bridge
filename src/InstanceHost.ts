import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { createAppServiceHandler } from './AppService.js'
import type { Problem } from './BridgeApi.js'
import { errorPlace, inside, outside } from './Boundary.js'
import { botUserId, ghostOwner, type MatrixIdentity } from './config.js'
import { GhostRegistry } from './Ghosts.js'
import type { HostApi, HostStatus, InstanceAccess, InstanceBridge } from './HostApi.js'
import { HostStore, type HostRoom } from './HostStore.js'
import { HttpError, type FetchImpl } from './http.js'
import type { MatrixClient } from './MatrixClient.js'
import { MatrixConnection } from './MatrixConnection.js'
import type { ManagedTimings } from './managed.js'
import { ENCRYPTED_ROOM, RoomLinks } from './RoomLinks.js'
import { inviteOf, type MatrixEvent, type Relay } from './Relay.js'
import { RoomDirectory } from './Rooms.js'
import { distinct, ServerBridge } from './ServerBridge.js'
import { QuotaError, Store, type Invite } from './Store.js'

export interface InstanceTimings extends ManagedTimings {
  /** How long a room without a pair or a code is kept. */
  linkMs: number
  sweepMs: number
  /** How long the others' events wait for a bridge that cannot take its own. */
  holdMs: number
  restartMs: number
}
export const INSTANCE_TIMINGS = { linkMs: 10 * 60_000, sweepMs: 15_000, holdMs: 60_000, restartMs: 5_000 }
const MAX_RESTART_MS = 5 * 60_000
// A bridge that ran this long starts over with the shortest wait.
const STABLE_MS = 10 * 60_000
// Rooms the account was invited to that no code was posted in yet.
export const MAX_WAITING_ROOMS = 50
// A transaction a bridge fails on this often goes on without it.
const TRIES = 3
const MAX_TRACKED = 100
// A bridge whose configuration is older than this does not hold up what is decided about rooms.
const STALE_CONFIG_MS = 5 * 60_000
const SKIPPED_SHOWN_MS = 60 * 60_000
// A join may take its whole minute when another homeserver does not answer.
const MAX_JOINING = 5
const JOIN_AGAIN_MS = 60_000
const JOIN_TRIES = 3
// Longer than any request a bridge has under way.
const STOP_MS = 65_000
const STOP_ROOMS_MS = 3_000
const CLOCK_SKEW_MS = 5 * 60_000

export interface InstanceOptions {
  dataDir: string
  version: string
  access: InstanceAccess
  endpoints: { apiBase: string; gatewayUrl: string }
  api: Pick<HostApi, 'link'>
  publicUrl: string | null
  timings: InstanceTimings
  fetchImpl?: FetchImpl
  /** The account belongs to the instance's bridge from now on. */
  claim: (homeserverUrl: string, userId: string) => void
  /** A room was linked to a bridge the list did not have yet. */
  onUnknownBridge: () => void
  /** What status() answers may have changed. */
  onState: () => void
  log: (line: string) => void
  warn: (line: string) => void
}

/** One server's bridge on the shared connection. */
interface Slot {
  readonly id: string
  token: string
  store?: Store
  bridge?: ServerBridge
  /** The rooms it pairs, as last known; null before its first configuration. */
  rooms: Set<string> | null
  /** Since when it cannot take events; null while it can. */
  downSince: number | null
  openedAt: number
  restarts: number
  restarting: boolean
  timer?: ReturnType<typeof setTimeout>
  skippedAt: number | null
  removed: boolean
}

/** The events wait: a bridge they concern cannot take them yet. */
class NotYet extends Error {}

const label = (id: string) => `[${id.slice(0, 8)}]`

/** The instance's Matrix connection, and the bridges of every server that uses it. */
export class InstanceHost {
  private readonly store: HostStore
  private readonly connection: MatrixConnection
  /** The application service's own requests; undefined for an account. */
  readonly requests?: (req: IncomingMessage, res: ServerResponse) => void
  private readonly slots = new Map<string, Slot>()
  /** Bridges being closed: until then nothing opens their databases again. */
  private readonly closings = new Map<string, Promise<void>>()
  /** Every bridge that ran. One that was stopped may still fail in what it had begun. */
  private readonly known = new Set<string>()
  private matrix?: MatrixClient
  private identity?: MatrixIdentity
  private registry?: GhostRegistry
  private links?: RoomLinks
  private directory?: RoomDirectory
  private listed = false
  private stopped = false
  private storageFailed = false
  private sweepTimer?: ReturnType<typeof setInterval>
  private roomTimer?: ReturnType<typeof setInterval>
  private sweeping?: Promise<void>
  private sweepAgain = false
  private readingRooms = false
  private followed = ''
  /** Invitations being accepted, and those that could not be yet: how often, and when they are tried again. */
  private readonly joining = new Set<string>()
  private readonly joinLater = new Map<string, { tries: number; at: number }>()
  /** What runs beside the rest. */
  private readonly work = new Set<Promise<void>>()
  /** A transaction or sync token and a bridge that failed on it. */
  private readonly failures = new Map<string, number>()
  /** Who a room was linked with last, ahead of what the bridges read. */
  private readonly owners = new Map<string, string>()

  constructor(private readonly options: InstanceOptions) {
    const { access, dataDir, timings, warn, log } = options
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    // Ghosts and the sync token belong to one Matrix user: another connection starts with its own.
    const user = access.connection === 'account' ? `account ${access.homeserver_url}` : `@${access.sender_localpart}:${access.server_name}`
    this.store = new HostStore(join(dataDir, `host-${createHash('sha256').update(user).digest('hex').slice(0, 16)}.sqlite`))
    this.connection = new MatrixConnection({
      access: access.connection === 'account' ? { kind: 'account', homeserverUrl: access.homeserver_url, accessToken: access.access_token }
        : { kind: 'application_service', homeserverUrl: access.homeserver_url, serverName: access.server_name, senderLocalpart: access.sender_localpart, asToken: access.as_token },
      store: this.store, accept: (userId, batch) => this.acceptSync(userId, batch), rooms: () => this.followedRooms(),
      onMembership: (roomId, membership) => this.membership(roomId, membership),
      onIdentity: (matrix, identity) => this.identified(matrix, identity),
      onUsable: async () => {
        await Promise.all([...this.slots.values()].map(slot => inside(slot.id, async () => {
          try {
            await slot.bridge?.begin()
            slot.bridge?.matrixUsable()
          } catch (error) { this.crashed(slot.id, error) }
        })))
        this.startSync()
        this.sweepSoon()
      },
      onState: () => {
        options.onState()
        for (const slot of this.slots.values()) slot.bridge?.statusSoon()
      },
      claim: async (homeserverUrl, userId) => { options.claim(homeserverUrl, userId); return true },
      tokenHint: 'An administrator of this Harmony can save a new access token in the admin panel.',
      registrationHint: 'give it the registration file made in Harmony\'s admin panel and restart it',
      fetchImpl: options.fetchImpl, timings, log, warn,
    })
    if (access.connection === 'application_service') {
      const handler = createAppServiceHandler({ hsToken: access.hs_token, botUserId: `@${access.sender_localpart}:${access.server_name}`, ownsGhost: id => this.store.ownsGhost(id),
        acceptTransaction: (id, events) => this.acceptTransaction(id, events), status: () => ({ ready: this.status().ready, pending: 0, failed: 0 }), report: warn })
      this.requests = (req, res) => { void handler(req, res) }
    }
  }

  start(): void {
    this.sweepTimer = setInterval(() => this.sweepSoon(), this.options.timings.sweepMs)
    this.roomTimer = setInterval(() => { void this.refreshRooms().catch(() => {}) }, this.options.timings.roomsMs)
    this.connection.start()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    clearInterval(this.sweepTimer)
    clearInterval(this.roomTimer)
    for (const slot of this.slots.values()) clearTimeout(slot.timer)
    let late: ReturnType<typeof setTimeout> | undefined
    // What waits for another homeserver is not waited out; it does nothing more.
    const rooms = Promise.race([Promise.all([this.sweeping, this.links?.settled(), ...this.work]), new Promise(resolve => { late = setTimeout(resolve, STOP_ROOMS_MS) })])
    await Promise.all([this.connection.stop(), rooms, ...[...this.slots.values()].map(slot => this.close(slot)), ...this.closings.values()])
    clearTimeout(late)
    this.store.close()
  }

  status(): NonNullable<HostStatus['instance']> {
    const problems = this.connection.problems()
    if (this.storageFailed) problems.push({ code: 'worker_stopped' })
    return { ready: !this.stopped && this.connection.receiving && !this.storageFailed, user_id: this.identity ? botUserId({ matrix: this.identity }) : null,
      server_name: this.identity?.serverName ?? null, problems: distinct(problems) }
  }

  private identified(matrix: MatrixClient, identity: MatrixIdentity): void {
    this.matrix = matrix
    this.identity = identity
    this.registry = new GhostRegistry(this.store, matrix)
    this.links = new RoomLinks({ matrix, api: this.options.api, store: this.store, isPerson: id => this.isPerson(id), publicUrl: this.options.publicUrl,
      onLinked: (roomId, bridgeId) => this.linked(roomId, bridgeId), onEncrypted: roomId => this.beside(() => this.leaveEncrypted(roomId)), report: line => this.options.warn(line) })
    this.directory = new RoomDirectory({ matrix, store: { invites: () => [] }, account: false, paired: () => [], rooms: () => [...this.pairedRooms()] })
    for (const slot of this.slots.values()) inside(slot.id, () => slot.bridge?.attach(matrix, identity))
  }

  private isPerson(userId: string): boolean {
    return this.identity !== undefined && userId !== botUserId({ matrix: this.identity }) && !ghostOwner({ matrix: this.identity }, userId)
  }

  // --- The bridges

  /** The bridges Harmony lists, whole. One that is gone stops; its data stays. */
  apply(bridges: InstanceBridge[]): void {
    if (this.stopped) return
    const wanted = new Map(bridges.map(bridge => [bridge.bridge_id, bridge.harmony_token]))
    for (const slot of [...this.slots.values()]) {
      const token = wanted.get(slot.id)
      if (token === undefined) {
        this.options.log(`${label(slot.id)} Bridge no longer listed; stopping`)
        slot.removed = true
        clearTimeout(slot.timer)
        this.slots.delete(slot.id)
        void this.close(slot)
      } else if (token !== slot.token) {
        this.options.log(`${label(slot.id)} Credentials changed; restarting`)
        slot.token = token
        slot.restarts = 0
        if (!slot.restarting) this.reopen(slot, 0)
      }
    }
    for (const [id, token] of wanted) {
      if (this.slots.has(id)) continue
      // One that comes while others run has bridged nothing yet: no event waits for it.
      const slot: Slot = { id, token, rooms: this.listed ? new Set() : null, downSince: Date.now(), openedAt: 0, restarts: 0, restarting: false, skippedAt: null, removed: false }
      this.slots.set(id, slot)
      const closing = this.closings.get(id)
      if (closing) void closing.then(() => this.open(slot))
      else this.open(slot)
    }
    this.listed = true
    this.startSync()
    this.sweepSoon()
  }

  private open(slot: Slot): void {
    if (this.stopped || slot.removed || slot.bridge) return
    slot.openedAt = Date.now()
    this.known.add(slot.id)
    inside(slot.id, () => {
      try {
        const { version, timings, fetchImpl, endpoints, access, log, warn } = this.options
        const dataDir = join(this.options.dataDir, slot.id)
        mkdirSync(dataDir, { recursive: true, mode: 0o700 })
        const store = slot.store = new Store(join(dataDir, 'bridge.sqlite'))
        const host = this
        const bridge = slot.bridge = new ServerBridge({
          version, store, harmony: { ...endpoints, token: slot.token }, connection: access.connection, fetchImpl, timings,
          // The operator's own address of it may be a private one.
          get homeserver() { return host.identity ? `https://${host.identity.serverName}` : '' },
          log: line => log(`${label(slot.id)} ${line}`), warn: line => warn(`${label(slot.id)} ${line}`),
          link: {
            get connected() { return host.connection.connected },
            get receiving() { return host.connection.receiving },
            problems: () => host.slotProblems(slot),
            rooms: () => (host.directory?.list() ?? []).filter(room => slot.rooms?.has(room.room_id)),
          },
          onPairs: () => outside(() => this.pairsChanged(slot)),
          refusedHint: 'The next reading of the host list brings a new one.',
          ghosts: this.shared(), ownsRoom: roomId => (this.owners.get(roomId) ?? slot.id) === slot.id, linkedOnly: true,
        })
        if (this.matrix) bridge.attach(this.matrix, this.identity!)
        void bridge.start()
      } catch (error) { this.crashed(slot.id, error) }
    })
  }

  /** The ghosts' registry, once there is a Matrix user to have any. */
  private shared(): GhostRegistry {
    return this.registry ?? new GhostRegistry(this.store, { registerGhost: refused, leaveGhost: refused, roomMember: refused })
  }

  /** An error of this bridge that nothing caught. True: it is dealt with. */
  crashed(id: string, error: unknown): boolean {
    const slot = this.slots.get(id)
    if (!slot || slot.restarting || this.stopped) return this.known.has(id)
    if (Date.now() - slot.openedAt >= STABLE_MS) slot.restarts = 0
    const delay = Math.min(MAX_RESTART_MS, this.options.timings.restartMs * 2 ** Math.min(slot.restarts++, 10))
    this.options.warn(`${label(id)} Bridge stopped by an error; restarting in ${Math.round(delay / 1000)} s. ${errorPlace(error)}`)
    this.reopen(slot, delay)
    return true
  }

  private reopen(slot: Slot, delay: number): void {
    slot.downSince ??= Date.now()
    slot.restarting = true
    const waited = new Promise<void>(resolve => { slot.timer = setTimeout(resolve, delay) })
    void Promise.all([this.close(slot), waited]).then(() => {
      slot.restarting = false
      this.open(slot)
    })
  }

  /** Stops the bridge and closes its database; what was under way is waited for, within bounds. */
  private close(slot: Slot): Promise<void> {
    const { bridge, store } = slot
    slot.bridge = undefined
    slot.store = undefined
    const closing = (this.closings.get(slot.id) ?? Promise.resolve()).then(async () => {
      let late: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([inside(slot.id, () => bridge?.stop()), new Promise(resolve => { late = setTimeout(resolve, STOP_MS) })])
      } catch (error) { this.options.warn(`${label(slot.id)} Bridge did not stop cleanly. ${errorPlace(error)}`) }
      clearTimeout(late)
      try { store?.close() } catch { /* Closed already. */ }
    }).finally(() => { if (this.closings.get(slot.id) === closing) this.closings.delete(slot.id) })
    this.closings.set(slot.id, closing)
    return closing
  }

  private pairsChanged(slot: Slot): void {
    const { bridge } = slot
    if (!bridge?.pairs || this.slots.get(slot.id) !== slot) return
    if (bridge.isReceiving) {
      slot.rooms = new Set(bridge.pairs.pairs.map(pair => pair.matrixRoomId))
      slot.downSince = null
    }
    const followed = this.followedRooms().join(' ')
    if (followed !== this.followed) {
      this.followed = followed
      this.connection.roomsChanged()
    }
    this.startSync()
    this.sweepSoon()
  }

  private slotProblems(slot: Slot): Problem[] {
    const problems = this.connection.problems()
    if (slot.skippedAt !== null && Date.now() - slot.skippedAt < SKIPPED_SHOWN_MS) problems.push({ code: 'messages_skipped', detail: 'Too many messages were waiting; some from Matrix were not copied.' })
    return problems
  }

  // --- Events

  /** Whether every bridge can be told its events, or has had its time. */
  private get pairsKnown(): boolean {
    return this.listed && [...this.slots.values()].every(slot => slot.rooms !== null || Date.now() - (slot.downSince ?? 0) >= this.options.timings.holdMs)
  }

  private startSync(): void {
    if (this.pairsKnown && this.connection.connected) this.connection.startSync()
  }

  private acceptTransaction(id: string, events: MatrixEvent[]): boolean {
    this.saveInvites(events)
    const changed = this.distribute(`transaction ${id}`, events, [], (relay, mine) => relay.acceptTransaction(id, mine))
    this.noteMemberships(events)
    this.links?.take(events)
    return changed
  }

  private acceptSync(userId: string, batch: Parameters<Relay['acceptSync']>[1]): boolean {
    this.distribute(`sync ${this.store.syncState(userId)?.nextBatch ?? ''}`, batch.events, batch.history, (relay, mine, past) => relay.acceptEvents(mine, past))
    this.guard(() => this.store.acceptSync(userId, batch.nextBatch, batch.rooms, []))
    // A room's first answer is history. A command in it counts when it came after the account did.
    const since = new Map(this.store.rooms().map(room => [room.roomId, room.waitingSince]))
    this.links?.take([...batch.history.filter(event => {
      const joined = since.get(event.room_id!)
      return typeof joined === 'number' && typeof event.origin_server_ts === 'number' && event.origin_server_ts >= joined - CLOCK_SKEW_MS
    }), ...batch.events])
    this.noteEncryption([...batch.history, ...batch.events])
    return true
  }

  /**
   * Each bridge its rooms' events, all of them stored before this returns. One that cannot take its
   * own holds the rest for a while, and then misses them.
   */
  private distribute(key: string, events: MatrixEvent[], history: MatrixEvent[], store: (relay: Relay, events: MatrixEvent[], history: MatrixEvent[]) => boolean): boolean {
    if (this.stopped || !this.pairsKnown) throw new NotYet('Pairs are not known yet')
    let changed = false
    let waits = false
    for (const slot of [...this.slots.values()]) {
      if (slot.rooms === null) continue
      const rooms = slot.rooms
      const mine = events.filter(event => rooms.has(event.room_id ?? ''))
      const past = history.filter(event => rooms.has(event.room_id ?? ''))
      if (!mine.length && !past.length) continue
      const failed = `${slot.id} ${key}`
      const { bridge } = slot
      if (!bridge?.isReceiving || (this.failures.get(failed) ?? 0) >= TRIES) {
        if (slot.downSince !== null && Date.now() - slot.downSince < this.options.timings.holdMs && (this.failures.get(failed) ?? 0) < TRIES) waits = true
        else this.skipped(slot)
        continue
      }
      try {
        if (inside(slot.id, () => store(bridge.relay!, mine, past))) changed = true
        this.failures.delete(failed)
      } catch (error) {
        if (error instanceof QuotaError) {
          try {
            inside(slot.id, () => bridge.relay!.acceptFences([...past, ...mine]))
            this.skipped(slot)
            continue
          } catch { /* Not full but broken. */ }
        }
        if (this.failures.size >= MAX_TRACKED) this.failures.delete(this.failures.keys().next().value!)
        this.failures.set(failed, (this.failures.get(failed) ?? 0) + 1)
        this.crashed(slot.id, error)
        waits = true
      }
    }
    if (waits) throw new NotYet('A bridge cannot take its events yet')
    return changed
  }

  private skipped(slot: Slot): void {
    if (slot.skippedAt === null || Date.now() - slot.skippedAt >= SKIPPED_SHOWN_MS) this.options.warn(`${label(slot.id)} Messages from Matrix were not copied: the bridge could not take them`)
    slot.skippedAt = Date.now()
    slot.bridge?.statusSoon()
  }

  private beside(run: () => Promise<void>): void {
    const running: Promise<void> = run().catch(error => {
      if (!(error instanceof HttpError) && !this.stopped) this.options.warn(`The instance's rooms could not be looked after; trying again. ${errorPlace(error)}`)
    }).finally(() => { this.work.delete(running) })
    this.work.add(running)
  }

  /** Runs a write to the host's own database. */
  private guard<T>(operation: () => T): T {
    try {
      const result = operation()
      this.storageFailed = false
      return result
    } catch (error) {
      if (!this.storageFailed && !this.stopped) this.options.warn('Local storage failed; check the disk of the bridge host')
      this.storageFailed = true
      throw error
    }
  }

  // --- Rooms

  private pairedRooms(): Set<string> {
    return new Set([...this.slots.values()].flatMap(slot => [...slot.rooms ?? []]))
  }

  /** Rooms the account is in: paired, or waiting for a code. */
  private followedRooms(): string[] {
    return [...new Set([...this.pairedRooms(), ...this.store.rooms().map(room => room.roomId)])].sort()
  }

  private room(roomId: string): HostRoom | undefined { return this.store.rooms().find(room => room.roomId === roomId) }

  /** Before the transaction is acknowledged; they are acted on after. */
  private saveInvites(events: MatrixEvent[]): void {
    for (const event of events) {
      if (!this.isOwnMembership(event) || event.content?.membership !== 'invite') continue
      const state = (event.unsigned as { invite_room_state?: unknown } | undefined)?.invite_room_state
      this.guard(() => this.store.saveInvite(inviteOf(event.room_id!, Array.isArray(state) ? state : [])))
    }
  }

  private isOwnMembership(event: MatrixEvent): boolean {
    return event.type === 'm.room.member' && this.identity !== undefined && event.state_key === botUserId({ matrix: this.identity }) && typeof event.room_id === 'string'
  }

  private noteMemberships(events: MatrixEvent[]): void {
    for (const event of events) if (this.isOwnMembership(event)) this.membership(event.room_id!, String(event.content?.membership))
    this.noteEncryption(events)
  }

  private membership(roomId: string, membership: string): void {
    if (membership !== 'invite') this.store.dropInvite(roomId)
    if (membership === 'leave' || membership === 'ban') this.store.dropRoom(roomId)
    for (const slot of this.slots.values()) if (slot.rooms?.has(roomId)) inside(slot.id, () => slot.bridge?.pairs?.noteMembership(roomId, membership))
    this.sweepSoon()
  }

  /** A room that waits for a code and turns on encryption. */
  private noteEncryption(events: MatrixEvent[]): void {
    const paired = this.pairedRooms()
    for (const event of events) {
      if (event.type !== 'm.room.encryption' || paired.has(event.room_id ?? '') || this.room(event.room_id ?? '')?.bridgeId !== null) continue
      this.beside(() => this.leaveEncrypted(event.room_id!))
    }
  }

  private linked(roomId: string, bridgeId: string): void {
    this.owners.set(roomId, bridgeId)
    this.guard(() => this.store.saveRoom({ roomId, bridgeId, waitingSince: Date.now() }))
    this.options.log(`${label(bridgeId)} Room linked`)
    for (const slot of this.slots.values()) inside(slot.id, () => { if (slot.id === bridgeId || slot.rooms?.has(roomId)) slot.bridge?.refreshConfigSoon() })
    if (!this.slots.has(bridgeId)) this.options.onUnknownBridge()
  }

  private async leaveEncrypted(roomId: string): Promise<void> {
    if (this.stopped) return
    try { await this.matrix!.sendMessage(roomId, createHash('sha256').update(`encrypted ${roomId} ${this.room(roomId)?.waitingSince ?? ''}`).digest('hex'), ENCRYPTED_ROOM, { notice: true }) }
    catch (error) { if (!(error instanceof HttpError)) throw error }
    if (this.stopped || this.pairedRooms().has(roomId)) return
    await this.leave(roomId, ENCRYPTED_ROOM)
    this.options.log('Left an encrypted room')
  }

  /** Ghosts first: they leave by themselves. */
  private async leave(roomId: string, reason?: string): Promise<void> {
    await this.registry!.clear(this.identity!, roomId)
    try { await this.matrix!.leaveRoom(roomId, reason) }
    catch (error) {
      // Not in it, or it is gone.
      if (!(error instanceof HttpError) || error.transient || error.status === 401) throw error
    }
    if (this.stopped) return
    this.guard(() => this.store.dropRoom(roomId))
    this.owners.delete(roomId)
    this.connection.roomsChanged()
  }

  private sweepSoon(): void {
    if (this.stopped || !this.connection.connected) return
    if (this.sweeping) { this.sweepAgain = true; return }
    this.sweeping = (async () => {
      do { this.sweepAgain = false; await this.sweep() } while (this.sweepAgain && !this.stopped)
    })().catch(error => {
      if (!(error instanceof HttpError)) this.options.warn(`The instance's rooms could not be looked after; trying again. ${errorPlace(error)}`)
    }).finally(() => { this.sweeping = undefined })
  }

  private async sweep(): Promise<void> {
    for (const slot of this.slots.values()) if (slot.bridge && !slot.bridge.isHealthy) this.crashed(slot.id, new Error('Storage failure'))
    this.acceptInvites()
    if (this.stopped || !this.listed) return
    this.notePairedRooms()
    for (const room of this.store.rooms()) {
      if (this.stopped) return
      if (room.waitingSince === null || this.pairedRooms().has(room.roomId) || !this.mayLeave(room, Date.now())) continue
      try {
        await this.leave(room.roomId, room.bridgeId === null ? 'No code was posted in this room.' : undefined)
        this.options.log(room.bridgeId === null ? 'Left a room nobody linked' : 'Left a room that is no longer linked')
      } catch (error) { if (!(error instanceof HttpError)) throw error }
    }
    await this.clearGhosts()
  }

  /** Every paired room is the account's to leave once it is no longer. */
  private notePairedRooms(): void {
    const known = new Map(this.store.rooms().map(room => [room.roomId, room]))
    const paired = new Set<string>()
    for (const slot of this.slots.values()) {
      for (const roomId of slot.rooms ?? []) {
        paired.add(roomId)
        const room = known.get(roomId)
        if (room && room.waitingSince === null && room.bridgeId === slot.id) continue
        // Two bridges name it for a moment while it moves: the one it was linked with last stays.
        if (room && this.owners.has(roomId) && this.owners.get(roomId) !== slot.id) continue
        this.guard(() => this.store.saveRoom({ roomId, bridgeId: slot.id, waitingSince: null }))
        known.set(roomId, { roomId, bridgeId: slot.id, waitingSince: null })
      }
    }
    for (const room of known.values()) {
      if (room.waitingSince === null && !paired.has(room.roomId)) this.guard(() => this.store.saveRoom({ ...room, waitingSince: Date.now() }))
    }
  }

  private mayLeave(room: HostRoom, now: number): boolean {
    const since = room.waitingSince!
    const owner = room.bridgeId === null ? undefined : this.slots.get(room.bridgeId)
    // Never linked, or its bridge is not listed: that may be a switch turned off for a moment.
    if (!owner) return now - since >= this.options.timings.linkMs
    // Unpaired for sure: every bridge read its configuration after, so it did not move to another.
    return [...this.slots.values()].every(slot => slot.bridge !== undefined && slot.bridge.configAt > since
      || (slot !== owner && now - since >= STALE_CONFIG_MS))
  }

  private acceptInvites(): void {
    for (const invite of this.store.invites()) {
      if (this.joining.size >= MAX_JOINING) return
      if (this.joining.has(invite.roomId) || Date.now() < (this.joinLater.get(invite.roomId)?.at ?? 0)) continue
      const paired = this.pairedRooms().has(invite.roomId)
      const waiting = new Set([...this.joining, ...this.store.rooms().filter(room => room.bridgeId === null && room.waitingSince !== null).map(room => room.roomId)]).size
      this.joining.add(invite.roomId)
      this.beside(async () => {
        try { await this.acceptInvite(invite, paired, waiting) }
        finally {
          this.joining.delete(invite.roomId)
          this.sweepSoon()
        }
      })
    }
  }

  private async acceptInvite(invite: Invite, paired: boolean, waiting: number): Promise<void> {
    try {
      if (!paired && (invite.encrypted || waiting >= MAX_WAITING_ROOMS)) {
        await this.matrix!.leaveRoom(invite.roomId, invite.encrypted ? ENCRYPTED_ROOM : 'The bridge waits in too many rooms. Invite it again later.')
        this.options.log(invite.encrypted ? 'Declined an encrypted room' : 'Declined an invitation: too many rooms wait for a code')
      } else {
        await this.matrix!.joinRoom(invite.roomId)
        if (this.stopped) return
        if (!paired) {
          this.guard(() => this.store.saveRoom({ roomId: invite.roomId, bridgeId: null, waitingSince: Date.now() }))
          this.connection.roomsChanged()
        }
      }
    } catch (error) {
      if (!(error instanceof HttpError)) throw error
      const tries = (this.joinLater.get(invite.roomId)?.tries ?? 0) + 1
      if (error.status === 401 || (error.transient && tries < JOIN_TRIES)) {
        this.joinLater.set(invite.roomId, { tries, at: Date.now() + JOIN_AGAIN_MS })
        return
      }
      // Withdrawn, or a room this homeserver cannot join.
    }
    if (this.stopped) return
    this.joinLater.delete(invite.roomId)
    this.guard(() => this.store.dropInvite(invite.roomId))
    if (!paired && this.room(invite.roomId) && !await this.matrix!.roomIsPlaintext(invite.roomId)) await this.leaveEncrypted(invite.roomId)
  }

  /** Ghosts of rooms no bridge keeps them in. */
  private async clearGhosts(): Promise<void> {
    const rooms = new Map(this.store.rooms().map(room => [room.roomId, room]))
    for (const roomId of this.store.ghostRooms()) {
      const kept = [...this.slots.values()].some(slot => {
        // A bridge that cannot say keeps what was its own.
        if (!slot.bridge?.isReceiving) return (slot.rooms?.has(roomId) ?? false) || (rooms.get(roomId)?.bridgeId ?? slot.id) === slot.id
        return slot.bridge.pairs!.keepsGhosts(roomId)
      })
      const bridgeId = rooms.get(roomId)?.bridgeId ?? null
      // That of a bridge not listed now is left with its room.
      if (kept || this.stopped || (bridgeId !== null && !this.slots.has(bridgeId))) continue
      try { await this.registry!.clear(this.identity!, roomId) }
      catch (error) { if (!(error instanceof HttpError)) throw error }
    }
  }

  private async refreshRooms(): Promise<void> {
    if (this.stopped || !this.directory || !this.connection.connected || this.readingRooms) return
    this.readingRooms = true
    try { await this.directory.refresh() }
    finally { this.readingRooms = false }
    for (const slot of this.slots.values()) slot.bridge?.roomsRead()
  }
}

async function refused(): Promise<never> { throw new HttpError('Not connected to Matrix', true) }
