import type { Problem } from './BridgeApi.js'
import { HttpError, ResponseTooLarge } from './http.js'
import type { MatrixClient, SyncBatch } from './MatrixClient.js'
import { inviteOf, type MatrixEvent, type Relay } from './Relay.js'
import type { Store } from './Store.js'

// Memberships: Synapse leaves out a left room none of whose events pass the filter, and the account's
// own join marks where history ends.
const TYPES = ['m.room.message', 'm.room.encryption', 'm.room.member']
// Synapse answers a filter with an empty room list with no rooms section, invites included (blocks_all_rooms).
const NO_ROOM = '!none:invalid'
/** At most 200 characters: bot-gateway cuts a problem's detail there. */
export const TOKEN_HINT = 'A token copied from a Matrix app works only where tokens do not expire; on matrix.org they do, within minutes. Run the bridge with --login for a lasting one and set it as MATRIX_ACCESS_TOKEN.'
const POLL_MS = 30_000
const TIMELINE_LIMIT = 100
// A room's missed messages are read back this far: 100 events a page.
const GAP_PAGES = 10
const MAX_BACKOFF_MS = 60_000
const QUEUE_FULL_MS = 5_000
// A homeserver that answers a long poll at once, with nothing, is asked no more often than this.
const IDLE_MS = 1_000
const SKIPPED_SHOWN_MS = 60 * 60_000
// Answers in a row that refuse the stored token before it is given up.
const TOKEN_REFUSALS = 3

export interface SyncLoopOptions {
  matrix: Pick<MatrixClient, 'sync' | 'createFilter' | 'messages'>
  store: Pick<Store, 'syncState' | 'clearSync' | 'saveInvite' | 'dropInvite'>
  relay: Pick<Relay, 'acceptSync'>
  userId: string
  /** The rooms to follow. `kept`: those of the stored token. */
  rooms: (kept: readonly string[]) => string[]
  onMembership?: (roomId: string, membership: 'invite' | 'leave') => void
  onState?: () => void
  report?: (message: string) => void
  pollMs?: number
  tokenHint?: string
}

function isEvent(value: unknown): value is MatrixEvent {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as { type?: unknown }).type === 'string'
}

/**
 * An ordinary account's events. The token is stored with what its response produced, so a crash
 * repeats a response and loses none. A room's first response is history: it carries fences only.
 */
export class SyncLoop {
  private running?: Promise<void>
  private stopped = false
  private abort?: AbortController
  private wake?: () => void
  private filter: { json: string; id: string } | null = null
  private limit = TIMELINE_LIMIT
  private problem: 'matrix_token_invalid' | 'matrix_unreachable' | null = 'matrix_unreachable'
  private readonly skipped = new Map<string, number>()
  private tokenRefusals = 0
  private retries = 0

  constructor(private readonly options: SyncLoopOptions) {}

  get connected(): boolean { return this.problem === null }

  problems(now = Date.now()): Problem[] {
    const problems: Problem[] = []
    if (this.problem) problems.push({ code: this.problem, ...(this.problem === 'matrix_token_invalid' ? { detail: this.options.tokenHint ?? TOKEN_HINT } : {}) })
    for (const [roomId, at] of this.skipped) {
      if (now - at > SKIPPED_SHOWN_MS) this.skipped.delete(roomId)
      else problems.push({ code: 'messages_skipped', detail: `Too many messages were missed in ${roomId}; the oldest were not copied.` })
    }
    return problems
  }

  start(): void {
    this.running ??= this.loop()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.abort?.abort()
    this.wake?.()
    await this.running
  }

  /** Pairs came or went: the poll in flight asks for the wrong rooms. */
  roomsChanged(): void {
    this.abort?.abort()
    this.wake?.()
  }

  private sleep(delay: number): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return new Promise(resolve => {
      const timer = setTimeout(done, delay)
      const self = this
      function done() { clearTimeout(timer); self.wake = undefined; resolve() }
      this.wake = done
    })
  }

  private setProblem(problem: SyncLoop['problem']): void {
    if (this.problem === problem) return
    this.problem = problem
    this.options.onState?.()
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      let delay = 0
      this.abort = new AbortController()
      const { signal } = this.abort
      try {
        const asked = Date.now()
        const idle = await this.once(signal)
        if (idle && Date.now() - asked < IDLE_MS) delay = IDLE_MS
        this.retries = 0
        this.setProblem(null)
      } catch (error) {
        if (this.stopped) return
        if (!signal.aborted) {
          try { delay = this.failed(error) }
          catch { delay = QUEUE_FULL_MS }
        }
      }
      if (delay) await this.sleep(delay)
    }
  }

  private failed(error: unknown): number {
    const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.retries++, 6))
    if (!(error instanceof HttpError)) {
      // A full queue, or local storage: the token stays where it was.
      if (this.retries === 1) this.options.report?.('Matrix events could not be stored yet; retrying')
      return QUEUE_FULL_MS
    }
    if (error instanceof ResponseTooLarge) {
      if (this.limit > 1) { this.limit = Math.max(1, Math.floor(this.limit / 4)); return 1 }
      // One event per room is still too much: start over from now.
      this.giveUpToken('')
      return backoff
    }
    if (error.status === 401) {
      this.setProblem('matrix_token_invalid')
      return MAX_BACKOFF_MS
    }
    this.filter = null
    if (!error.transient && error.status === 400) {
      if (++this.tokenRefusals >= TOKEN_REFUSALS) this.giveUpToken('')
    }
    this.setProblem('matrix_unreachable')
    return Math.max(backoff, error.retryAfterMs ?? 0)
  }

  private giveUpToken(roomId: string): void {
    this.tokenRefusals = 0
    this.options.store.clearSync(this.options.userId)
    this.skipped.set(roomId || 'every room', Date.now())
    this.options.report?.('The homeserver no longer takes the stored sync token; starting from now')
  }

  private async filterFor(rooms: string[], limit: number): Promise<string> {
    const filter = { presence: { types: [] }, account_data: { types: [] }, room: { rooms: rooms.length ? rooms : [NO_ROOM], include_leave: false,
      ephemeral: { types: [] }, account_data: { types: [] }, state: { types: ['m.room.encryption'] }, timeline: { types: TYPES, limit } } }
    const json = JSON.stringify(filter)
    if (this.filter?.json !== json) this.filter = { json, id: await this.options.matrix.createFilter(filter) }
    return this.filter.id
  }

  /** One response, stored whole. True when it held nothing. */
  async once(signal?: AbortSignal): Promise<boolean> {
    const { matrix, store, relay, userId } = this.options
    const state = store.syncState(userId)
    const followed = new Set(state?.rooms ?? [])
    const rooms = this.options.rooms(state?.rooms ?? [])
    // A room new to the filter: its response answers at once and is history.
    const fresh = !state || rooms.some(room => !followed.has(room))
    const batch = await matrix.sync({ filter: await this.filterFor(rooms, state ? this.limit : 1), since: state?.nextBatch,
      timeoutMs: fresh ? 0 : this.options.pollMs ?? POLL_MS, signal })
    this.tokenRefusals = 0

    const events: MatrixEvent[] = []
    const history: MatrixEvent[] = []
    for (const roomId of rooms) {
      const room = batch.joined.get(roomId)
      if (!room) continue
      const here = (values: unknown[]) => values.filter(isEvent).map(event => ({ ...event, room_id: roomId }))
      history.push(...here(room.state))
      if (!state || !followed.has(roomId)) { history.push(...here(room.timeline.events)); continue }
      const gap = room.timeline.limited ? await this.missed(roomId, room.timeline.prev_batch, state.nextBatch) : []
      const since = here([...gap, ...room.timeline.events])
      const start = since.map(event => this.ownJoin(event)).lastIndexOf(true) + 1
      history.push(...since.slice(0, start))
      events.push(...since.slice(start))
    }
    const left = new Set([...batch.left, ...batch.invited.keys()])
    relay.acceptSync(userId, { nextBatch: batch.nextBatch, rooms: rooms.filter(room => !left.has(room)), events, history })
    this.noteMemberships(batch)
    if (this.limit < TIMELINE_LIMIT && state) this.limit = Math.min(TIMELINE_LIMIT, this.limit * 2)
    return !fresh && !batch.joined.size && !batch.invited.size && !batch.left.length
  }

  /** A join after a join is a change of name or avatar. */
  private ownJoin(event: MatrixEvent): boolean {
    const previous = (event.unsigned as { prev_content?: { membership?: unknown } } | undefined)?.prev_content
    return event.type === 'm.room.member' && event.state_key === this.options.userId && event.content?.membership === 'join' && previous?.membership !== 'join'
  }

  /** The events between the stored token and a limited timeline, oldest first. */
  private async missed(roomId: string, from: string | undefined, to: string): Promise<unknown[]> {
    const pages: unknown[][] = []
    let next = from
    if (from === undefined) this.skipped.set(roomId, Date.now())
    for (let page = 0; next !== undefined; page++) {
      if (page === GAP_PAGES) {
        if (pages.at(-1)!.length) this.skipped.set(roomId, Date.now())
        break
      }
      let read: { events: unknown[]; end?: string }
      try { read = await this.options.matrix.messages(roomId, next, to, TYPES) }
      catch (error) {
        if (!(error instanceof HttpError) || error.transient || error.status === 401) throw error
        this.skipped.set(roomId, Date.now())
        break
      }
      pages.push(read.events)
      next = read.end === next ? undefined : read.end
    }
    return pages.flat().reverse()
  }

  private noteMemberships(batch: SyncBatch): void {
    const { store, onMembership } = this.options
    for (const [roomId, state] of batch.invited) {
      store.saveInvite(inviteOf(roomId, state))
      onMembership?.(roomId, 'invite')
    }
    for (const roomId of batch.left) {
      store.dropInvite(roomId)
      onMembership?.(roomId, 'leave')
    }
  }
}
