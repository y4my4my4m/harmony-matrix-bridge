import type { StatusReport } from './BridgeApi.js'
import { HttpError } from './http.js'
import type { MatrixClient, RoomInfo } from './MatrixClient.js'
import type { Store } from './Store.js'

export const MAX_ROOMS = 500
// Each room is five or six small requests.
const ROOMS_PER_PASS = 20
const FRESH_MS = 10 * 60_000

export interface RoomDirectoryOptions {
  matrix: Pick<MatrixClient, 'joinedRooms' | 'directRooms' | 'roomInfo'>
  store: Pick<Store, 'invites'>
  /** An ordinary account's direct chats are nobody else's business. */
  account: boolean
  /** Rooms of pairs come first. */
  paired: () => readonly string[]
  /** The rooms to describe; default: every room the account is in, MAX_ROOMS of them. */
  rooms?: () => readonly string[]
}

/** The rooms a manager can pair: joined ones first, then invites, at most MAX_ROOMS. */
export class RoomDirectory {
  private readonly known = new Map<string, { info: RoomInfo | null; at: number }>()
  private joined: string[] = []
  private direct = new Set<string>()
  private directAt = -Infinity

  constructor(private readonly options: RoomDirectoryOptions) {}

  /** Reads the membership list and the rooms that are missing or old, a few at a time. */
  async refresh(now = Date.now()): Promise<void> {
    const { matrix, account, rooms } = this.options
    if (account && !rooms && now - this.directAt >= FRESH_MS) {
      this.direct = await matrix.directRooms()
      this.directAt = now
    }
    if (rooms) this.joined = [...rooms()]
    else {
      const joined = (await matrix.joinedRooms()).filter(id => !this.direct.has(id))
      const paired = new Set(this.options.paired())
      this.joined = [...joined.filter(id => paired.has(id)), ...joined.filter(id => !paired.has(id))].slice(0, MAX_ROOMS)
    }
    for (const id of this.known.keys()) if (!this.joined.includes(id)) this.known.delete(id)
    const due = this.joined.filter(id => now - (this.known.get(id)?.at ?? -Infinity) >= FRESH_MS)
      .sort((a, b) => (this.known.get(a)?.at ?? 0) - (this.known.get(b)?.at ?? 0))
    for (const id of due.slice(0, ROOMS_PER_PASS)) {
      try { this.known.set(id, { info: await matrix.roomInfo(id), at: now }) }
      catch (error) {
        if (!(error instanceof HttpError)) throw error
        // Transient: the next pass asks again. Refused: not offered until its turn comes round.
        if (error.transient) return
        this.known.set(id, { info: null, at: now })
      }
    }
  }

  list(): StatusReport['rooms'] {
    const rooms: StatusReport['rooms'] = []
    for (const id of this.joined) {
      const info = this.known.get(id)?.info
      if (info) rooms.push(info)
    }
    for (const invite of this.options.store.invites()) {
      if (rooms.length >= MAX_ROOMS) break
      if (this.joined.includes(invite.roomId)) continue
      rooms.push({ room_id: invite.roomId, name: invite.name, alias: invite.alias, encrypted: invite.encrypted, can_send: true, members: 0, invited: true })
    }
    return rooms
  }
}
