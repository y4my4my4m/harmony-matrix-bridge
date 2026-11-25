import type { ManagedPair, PairReport, Problem } from './BridgeApi.js'
import type { LivePair } from './config.js'
import type { HarmonyClient } from './HarmonyClient.js'
import { HttpError } from './http.js'
import type { MatrixClient } from './MatrixClient.js'
import type { Store } from './Store.js'

export type PairError = 'room_not_found' | 'not_invited' | 'room_encrypted' | 'channel_encrypted' | 'cannot_send' | 'room_in_use'
  | 'ghosts_unavailable' | 'harmony_not_bound'

export interface PairManagerOptions {
  harmony: Pick<HarmonyClient, 'check' | 'bridgeRoom'>
  matrix: Pick<MatrixClient, 'resolveAlias' | 'membership' | 'joinRoom' | 'roomIsPlaintext' | 'canSend'>
  store: Pick<Store, 'isRoomBlocked' | 'pairStart' | 'prunePairStarts' | 'isInvited' | 'dropInvite'>
  /** False for an ordinary account: every pair relays through it. */
  ghosts: boolean
  /** `pairs` was replaced. */
  onPairs?: () => void
  onReady?: (channelId: string) => void
  onRemoved?: (channelId: string) => void
  /** Harmony names another room than the configuration read last. */
  onStale?: () => void
  report?: (message: string) => void
}

interface Entry {
  spec: ManagedPair
  /** Known at once for a pair named by ID, else once the alias resolves. */
  roomId: string | null
  relaying: boolean
  error: PairError | null
  ghostsRefused: boolean
  /** The bridge is in the room now. */
  member: boolean
  /** It was, for this pair: a room it was removed from is not joined again without an invite. */
  wasMember: boolean
  /** Epoch ms; kept across restarts. */
  since: number | null
  failures: number
  dueAt: number
}

/** Errors that stop the relay. With cannot_send, Matrix still reaches Harmony. */
const stops = (error: PairError | null) => error !== null && error !== 'cannot_send'

const CONCURRENT = 4
const TICK_MS = 1_000
const RECHECK_MS = 10 * 60_000
const RETRY_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000]

class PairRefused extends Error {
  constructor(readonly code: PairError) { super(code) }
}
/** Permanent refusals of `operation` become the pair's error; what may pass, a refused token included, is thrown as it is. */
async function refusing<T>(code: PairError | ((error: HttpError) => PairError), operation: () => Promise<T>): Promise<T> {
  try { return await operation() }
  catch (error) {
    if (error instanceof HttpError && !error.transient && error.status !== 401) throw new PairRefused(typeof code === 'string' ? code : code(error))
    throw error
  }
}

/** The managed pairs: each is resolved, joined, checked and bound by itself while the others run. */
export class PairManager {
  private readonly entries = new Map<string, Entry>()
  private readonly running = new Set<string>()
  private timer?: ReturnType<typeof setInterval>
  private readonly startedAt = Date.now()
  private stopped = false
  private ready = false
  pairs: LivePair[] = []

  constructor(private readonly options: PairManagerOptions) {}

  /** Checks begin once Matrix is usable; pairs are known, and their events kept, before that. */
  start(): void {
    this.ready = true
    if (!this.timer) this.timer = setInterval(() => { this.kick() }, TICK_MS)
    this.kick()
  }

  stop(): void {
    this.stopped = true
    clearInterval(this.timer)
  }

  /** The configuration's pairs, whole. */
  apply(specs: ManagedPair[]): void {
    const wanted = new Map(specs.map(spec => [spec.channelId, spec]))
    const gone: string[] = []
    for (const [channelId, entry] of this.entries) {
      const spec = wanted.get(channelId)
      // A pair bound since it was read by alias now carries its room ID.
      const same = spec && (spec.roomId !== null ? spec.roomId === entry.roomId
        : entry.spec.roomId === null && spec.roomAlias === entry.spec.roomAlias)
      if (!same) {
        this.entries.delete(channelId)
        gone.push(channelId)
        continue
      }
      if (spec.encrypted !== entry.spec.encrypted || spec.direction !== entry.spec.direction || spec.senderMode !== entry.spec.senderMode) {
        entry.dueAt = 0
        entry.ghostsRefused = false
      }
      entry.spec = spec
    }
    for (const spec of specs) {
      if (this.entries.has(spec.channelId)) continue
      this.entries.set(spec.channelId, { spec, roomId: spec.roomId, relaying: false, error: null, ghostsRefused: false,
        member: false, wasMember: false, since: null, failures: 0, dueAt: 0 })
    }
    this.options.store.prunePairStarts((channelId, roomId) => {
      const entry = this.entries.get(channelId)
      return !!entry && (entry.roomId ?? roomId) === roomId
    })
    this.rebuild()
    for (const channelId of gone) this.options.onRemoved?.(channelId)
    this.kick()
  }

  private rebuild(): void {
    const pairs: LivePair[] = []
    for (const [channelId, entry] of this.entries) {
      if (entry.roomId === null) continue
      entry.since ??= this.options.store.pairStart(channelId, entry.roomId)
      pairs.push({ harmonyChannelId: channelId, matrixRoomId: entry.roomId, direction: entry.spec.direction,
        senderMode: this.options.ghosts ? entry.spec.senderMode : 'relay',
        state: entry.relaying ? 'ready' : stops(entry.error) ? 'error' : 'joining',
        since: entry.since })
    }
    this.pairs = pairs
    this.options.onPairs?.()
  }

  /** Rooms the bridge is in for a pair. `kept`: rooms that were before a restart, until checked again. */
  joinedRooms(kept: readonly string[] = []): string[] {
    const rooms: string[] = []
    for (const entry of this.entries.values()) {
      if (entry.roomId !== null && (entry.member || (!entry.wasMember && kept.includes(entry.roomId)))) rooms.push(entry.roomId)
    }
    return [...new Set(rooms)].sort()
  }

  /** Whether a room's ghosts stay. An alias not resolved yet may name any room. */
  keepsGhosts(roomId: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.roomId === null && !stops(entry.error)) return true
      if (entry.roomId === roomId) return !stops(entry.error)
    }
    return false
  }

  /** The homeserver told of the bridge's own membership. */
  noteMembership(roomId: string, membership: string): void {
    for (const entry of this.entries.values()) {
      if (entry.roomId !== roomId) continue
      if (membership !== 'join') entry.member = false
      entry.dueAt = 0
    }
    this.kick()
  }

  /** Checked at once, so that its ghosts leave and Harmony hears of it. */
  noteEncrypted(roomId: string): void {
    for (const entry of this.entries.values()) if (entry.roomId === roomId) entry.dueAt = 0
    this.kick()
  }

  /** A refresh was refused for good. */
  recheck(channelId: string): void {
    const entry = this.entries.get(channelId)
    if (entry) entry.dueAt = 0
    this.kick()
  }

  noteGhosts(channelId: string, usable: boolean): void {
    const entry = this.entries.get(channelId)
    if (entry && this.options.ghosts) entry.ghostsRefused = !usable && entry.spec.senderMode === 'ghost'
  }

  reports(): PairReport[] {
    return [...this.entries].map(([channel_id, entry]) => {
      const error = entry.error ?? (entry.ghostsRefused ? 'ghosts_unavailable' as const : null)
      return { channel_id, state: error ? 'error' : entry.relaying ? 'ready' : 'joining', error }
    })
  }

  problems(): Problem[] {
    const problems: Problem[] = []
    for (const entry of this.entries.values()) {
      const detail = entry.spec.roomAlias ?? entry.roomId ?? undefined
      if (entry.error === 'room_encrypted') problems.push({ code: 'room_encrypted', detail })
      if (entry.error === 'not_invited' || entry.error === 'room_not_found') problems.push({ code: 'room_not_joined', detail })
    }
    return problems
  }

  private kick(): void {
    if (this.stopped || !this.ready) return
    const now = Date.now()
    for (const [channelId, entry] of this.entries) {
      if (this.running.size >= CONCURRENT) return
      if (entry.dueAt > now || this.running.has(channelId)) continue
      this.running.add(channelId)
      entry.dueAt = now + RECHECK_MS
      void this.run(channelId, entry).catch(() => {
        this.options.report?.('A pair could not be kept; check local storage')
        this.later(entry, RECHECK_MS)
      }).finally(() => { this.running.delete(channelId); this.kick() })
    }
  }

  private async run(channelId: string, entry: Entry): Promise<void> {
    const current = () => !this.stopped && this.entries.get(channelId) === entry
    let error: PairError | null = null
    try { await this.check(entry, current) }
    catch (thrown) {
      if (!current()) return
      if (thrown instanceof PairRefused) error = thrown.code
      else {
        // Nothing was learned: a relaying pair goes on, checked at every delivery, and a joining one waits.
        const delay = RETRY_MS[Math.min(entry.failures++, RETRY_MS.length - 1)]
        this.later(entry, Math.max(delay, thrown instanceof HttpError ? thrown.retryAfterMs ?? 0 : 0))
        if (!(thrown instanceof HttpError)) this.options.report?.('A pair could not be checked; check local storage')
        return
      }
    }
    if (!current()) return
    const before = { relaying: entry.relaying, error: entry.error }
    entry.error = error
    entry.relaying = !stops(error)
    if (error === null) entry.failures = 0
    else this.later(entry, RETRY_MS[Math.min(1 + entry.failures++, RETRY_MS.length - 1)])
    if (before.relaying !== entry.relaying || before.error !== entry.error) {
      this.rebuild()
      if (entry.relaying && !before.relaying) this.options.onReady?.(channelId)
    }
  }

  /** A change noted while the check ran keeps its turn. */
  private later(entry: Entry, delay: number): void {
    if (entry.dueAt !== 0) entry.dueAt = Date.now() + delay
  }

  private async check(entry: Entry, current: () => boolean): Promise<void> {
    const { harmony, matrix, store } = this.options
    const { channelId, roomAlias } = entry.spec
    if (entry.spec.encrypted) throw new PairRefused('channel_encrypted')
    const bound = await refusing('harmony_not_bound', () => harmony.check(channelId))
    if (!bound.registered) throw new PairRefused('harmony_not_bound')
    if (!bound.plaintext) throw new PairRefused('channel_encrypted')

    let roomId = entry.roomId
    let servers: string[] = []
    if (roomId === null) {
      const resolved = await refusing('room_not_found', () => matrix.resolveAlias(roomAlias!))
      if (!current()) return
      roomId = resolved.roomId
      servers = resolved.servers
    }
    const room = roomId
    for (const [other, { roomId: taken }] of this.entries) if (other !== channelId && taken === room) throw new PairRefused('room_in_use')
    // Known before the join: a fenced room stays fenced.
    if (store.isRoomBlocked(room)) throw new PairRefused('room_encrypted')

    const membership = await matrix.membership(room)
    if (!current()) return
    if (membership !== 'join') {
      entry.member = false
      // A pair kept from an earlier run that shows 'leave' was removed while the bridge was down.
      const removed = entry.wasMember || (membership === 'leave' && entry.since !== null && entry.since < this.startedAt)
      const invited = membership === 'invite' || store.isInvited(room)
      if (membership === 'ban' || (removed && !invited)) throw new PairRefused('not_invited')
      await refusing(error => error.status === 403 ? 'not_invited' : 'room_not_found', () => matrix.joinRoom(room, servers))
      if (!current()) return
    }
    store.dropInvite(room)
    const known = entry.member && entry.roomId !== null
    entry.member = true
    entry.wasMember = true
    entry.roomId = room
    // From here the room's events are taken, its fences first.
    if (!known) this.rebuild()
    if (!await matrix.roomIsPlaintext(room) || store.isRoomBlocked(room)) throw new PairRefused('room_encrypted')
    if (!current()) return

    if (bound.roomId !== room) await this.bind(entry, room)
    if (!current()) return
    if (entry.spec.direction !== 'to_harmony' && !await matrix.canSend(room)) throw new PairRefused('cannot_send')
  }

  private async bind(entry: Entry, roomId: string): Promise<void> {
    const { harmony, ghosts } = this.options
    const { channelId, roomAlias, senderMode } = entry.spec
    let binding: { room_id: string | null }
    try {
      binding = await harmony.bridgeRoom(channelId, { room_id: roomId, initial_sender_mode: ghosts ? senderMode : 'relay',
        ...(roomAlias ? { room_alias: roomAlias } : {}) })
    } catch (error) {
      if (!(error instanceof HttpError)) throw error
      if (error.errcode === 'room_in_use') throw new PairRefused('room_in_use')
      if (error.errcode === 'room_changed') {
        this.options.onStale?.()
        throw new HttpError('Pair configuration is out of date', true)
      }
      if (!error.transient && error.status !== 401) throw new PairRefused('harmony_not_bound')
      throw error
    }
    if (binding.room_id !== roomId) throw new PairRefused('room_in_use')
  }
}
