import { ghostOwner, ghostUserId, listAllows, type MatrixIdentity, type Pair, type RelaySettings } from './config.js'
import type { Store } from './Store.js'
import { HttpError } from './http.js'
import type { BridgeCheck, BridgeMember, SenderMode } from './HarmonyClient.js'
import type { HarmonyTransport, MatrixTransport } from './Relay.js'

// Ghosts appear before they speak, for mention completion, in channels of at most this many eligible members.
export const MAX_GHOSTS_AHEAD = 100
// Ghosts prepared in one pass; queued messages go out between passes.
const GHOSTS_PER_PASS = 10

/** The homeserver does not let the bridge act as this ghost: no namespace, a collision, or no right to invite. */
export class GhostRefused extends HttpError {
  constructor(cause: HttpError) { super('Ghost account refused', false, cause.status, cause.errcode) }
}
async function ghostly<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation() }
  catch (error) { throw error instanceof HttpError && !error.transient ? new GhostRefused(error) : error }
}

export type GhostStore = Pick<Store, 'reserveGhost' | 'registerGhost' | 'ownsGhost' | 'trackGhostRoom' | 'ghostRooms' | 'roomGhosts'
  | 'forgetGhostRoom' | 'ghostProfile' | 'setGhostProfile'>

/** Ghost accounts, one per Harmony user: registered once, however many channels or servers need one at a time. */
export class GhostRegistry {
  private readonly ready = new Set<string>()
  private readonly running = new Map<string, Promise<void>>()
  constructor(readonly store: GhostStore, private readonly matrix: Pick<MatrixTransport, 'registerGhost' | 'leaveGhost' | 'roomMember'>) {}

  register(id: string, owner: string): Promise<void> {
    if (this.ready.has(id)) return Promise.resolve()
    let run = this.running.get(id)
    if (!run) {
      run = (async () => {
        const known = this.store.reserveGhost(id, owner)
        await ghostly(() => this.matrix.registerGhost(id, known))
        this.store.registerGhost(id)
        this.ready.add(id)
      })().finally(() => this.running.delete(id))
      this.running.set(id, run)
    }
    return run
  }

  /** Ghosts of a room leave, but for `keep`. */
  async clear(identity: MatrixIdentity, roomId: string, keep: ReadonlySet<string> = new Set()): Promise<void> {
    for (const id of this.store.roomGhosts(roomId)) {
      if (!ghostOwner({ matrix: identity }, id)) throw new HttpError('Stored ghost outside configured namespace; restore original registration', false)
      if (!keep.has(id)) await this.remove(roomId, id)
    }
  }

  async remove(roomId: string, id: string): Promise<void> {
    this.store.setGhostProfile(roomId, id, null)
    await this.leave(roomId, id)
    this.store.forgetGhostRoom(roomId, id)
  }

  private async leave(roomId: string, id: string): Promise<void> {
    try { await this.matrix.leaveGhost(roomId, id) }
    catch (error) {
      if (!(error instanceof HttpError) || (error.status !== 403 && error.status !== 404)) throw error
      // Kicked, banned or in a room that is gone: there is nothing to leave. A ghost still joined stays tracked.
      try { await this.matrix.roomMember(roomId, id) }
      catch (state) {
        if (state instanceof HttpError && !state.transient) return
        throw state
      }
      throw error
    }
  }
}

export interface GhostSync {
  /** The pass ended early. */
  more: boolean
  /** Whether the homeserver let a ghost be prepared; null when none was tried. */
  usable: boolean | null
  prepared: number
}

/** One caller at a time for a room: Relay holds the channel's lane. */
export class Ghosts {
  // shortcut: unchanged avatar URLs stay cached until restart; revalidate if in-place uploads need live refresh.
  private readonly avatars = new Map<string, string>()
  /** Room and ghost: the last try failed for this member alone; others come first. */
  private readonly postponed = new Set<string>()
  /** Eligible members at the last sync, by room. */
  private readonly eligibleCount = new Map<string, number>()
  /** `owns`: false for a room that is another bridge's by now: its ghosts are not this one's to remove. */
  constructor(private readonly config: RelaySettings, private readonly fences: Pick<Store, 'isRoomBlocked'>, private readonly registry: GhostRegistry,
    private readonly harmony: HarmonyTransport, private readonly matrix: MatrixTransport, private readonly owns: (roomId: string) => boolean = () => true) {}

  private get store(): GhostStore { return this.registry.store }
  private get account(): boolean { return this.config.matrix.userId !== undefined }

  /** What Harmony and the room say now, refused unless profiles may pass between them. */
  async allowed(pair: Pair, userId?: string): Promise<BridgeCheck & { mode: SenderMode }> {
    const check = await this.harmony.check(pair.harmonyChannelId, userId)
    if (!check.registered || check.mode === null) throw new HttpError('Channel is not registered to this Matrix bridge', false)
    if (check.roomId !== pair.matrixRoomId) throw new HttpError('Matrix room binding differs from configuration', false)
    if (!check.plaintext || !await this.matrix.roomIsPlaintext(pair.matrixRoomId) || this.fences.isRoomBlocked(pair.matrixRoomId)) {
      throw new HttpError('Profile sync requires verified plaintext rooms', false)
    }
    return { ...check, mode: check.mode }
  }

  async eligible(pair: Pair): Promise<BridgeMember[]> {
    return (await this.harmony.bridgeMembers(pair.harmonyChannelId)).filter(member => listAllows(this.config.harmony.allowedUserIds, member.id))
  }

  /** The member, when they may be shown on Matrix now. */
  private async consent(pair: Pair, userId: string): Promise<BridgeMember> {
    if (!listAllows(this.config.harmony.allowedUserIds, userId)) throw new HttpError('Ghost profile is not currently permitted', false)
    const check = await this.allowed(pair, userId)
    if (!check.relayAllowed || check.mode !== 'ghost' || !check.member) throw new HttpError('Ghost profile is not currently permitted', false)
    return check.member
  }

  /** Whether the member's ghost is in the room with this profile, as far as the bridge knows. */
  isCurrent(pair: Pair, member: BridgeMember): boolean {
    return this.store.ghostProfile(pair.matrixRoomId, ghostUserId(this.config, member.id)) === profileKey(member)
  }

  /** The ghost is not in the room after all. */
  forget(roomId: string, id: string): void { this.store.setGhostProfile(roomId, id, null) }

  /** Registers, names and joins the ghost. Every remote write follows a check of its own. */
  async ensure(pair: Pair, member: BridgeMember): Promise<string> {
    await this.consent(pair, member.id)
    const id = ghostUserId(this.config, member.id)
    await this.registry.register(id, member.id)
    let current = await this.consent(pair, member.id)
    let avatar: string | undefined
    const url = current.avatar_url
    if (url) {
      // shortcut: cache follows avatar URL changes, restart to refresh an overwrite at the same URL.
      const key = `${member.id}:${url}`
      avatar = this.avatars.get(key)
      if (!avatar) {
        let image
        try { image = await this.harmony.nativeAvatar(pair.harmonyChannelId, member.id) }
        catch { /* Optional avatar bytes are served only by the trusted eligible-member endpoint. */ }
        await this.consent(pair, member.id)
        if (image) {
          try {
            avatar = await this.matrix.uploadAvatar(image)
            if (this.avatars.size >= 256) this.avatars.delete(this.avatars.keys().next().value!)
            this.avatars.set(key, avatar)
          } catch { /* Missing avatars must not replace ghost mode with relay attribution. */ }
        }
        current = await this.consent(pair, member.id)
      }
    }
    if (current.avatar_url !== url) avatar = undefined
    // Track before remote join so a crash still leaves enough state for later cleanup.
    this.store.trackGhostRoom(pair.matrixRoomId, id)
    this.store.setGhostProfile(pair.matrixRoomId, id, null)
    await ghostly(() => this.matrix.joinGhost(pair.matrixRoomId, id, { displayname: current.display_name || current.username,
      ...(current.avatar_url ? (avatar ? { avatar_url: avatar } : {}) : { avatar_url: '' }) }))
    this.store.setGhostProfile(pair.matrixRoomId, id, profileKey(current))
    return id
  }

  async cleanup(pair: Pick<Pair, 'matrixRoomId'>, keep: Set<string>): Promise<void> {
    if (this.owns(pair.matrixRoomId)) await this.registry.clear(this.config.matrix, pair.matrixRoomId, keep)
  }

  /** `allowed`, after which a refusal for good has removed the room's ghosts. */
  private async allowedOrRemoved(pair: Pair, userId?: string): Promise<BridgeCheck & { mode: SenderMode }> {
    try { return await this.allowed(pair, userId) }
    catch (error) {
      if (error instanceof HttpError && !error.transient && !this.account) await this.cleanup(pair, new Set())
      throw error
    }
  }

  /**
   * Ghosts of `pair` in step with its eligible members: those no longer eligible leave, and a small
   * channel's are prepared ahead.
   */
  async sync(pair: Pair): Promise<GhostSync> {
    const { mode } = await this.allowedOrRemoved(pair)
    const result: GhostSync = { more: false, usable: null, prepared: 0 }
    if (this.account) return result
    let eligible: BridgeMember[] = []
    if (mode === 'ghost') {
      try { eligible = await this.eligible(pair) }
      catch (error) {
        if (error instanceof HttpError && !error.transient) await this.cleanup(pair, new Set())
        throw error
      }
    }
    if (mode === 'ghost') this.eligibleCount.set(pair.matrixRoomId, eligible.length)
    else this.eligibleCount.delete(pair.matrixRoomId)
    await this.cleanup(pair, new Set(eligible.map(member => ghostUserId(this.config, member.id))))
    if (eligible.length > MAX_GHOSTS_AHEAD) return result
    const key = (member: BridgeMember) => `${pair.matrixRoomId} ${ghostUserId(this.config, member.id)}`
    const due = eligible.filter(member => !this.isCurrent(pair, member))
    const fresh = due.filter(member => !this.postponed.has(key(member)))
    const again = due.filter(member => this.postponed.has(key(member)))
    if (this.postponed.size > 10_000) this.postponed.clear()
    result.more = fresh.length > GHOSTS_PER_PASS
    for (const member of [...fresh, ...again].slice(0, GHOSTS_PER_PASS)) {
      try {
        result.prepared++
        await this.ensure(pair, member)
        result.usable = true
        this.postponed.delete(key(member))
      } catch (error) {
        if (!(error instanceof HttpError) || error.transient) throw error
        if (error instanceof GhostRefused) return { ...result, more: false, usable: false }
        // One member's consent changed during the pass; the others are not held up by it.
        this.postponed.add(key(member))
      }
    }
    return result
  }

  /** One member joined or left the server. Asks Harmony only when their ghost is here or may come ahead of speech. */
  async reconcile(pair: Pair, userId: string): Promise<void> {
    if (this.account || !listAllows(this.config.harmony.allowedUserIds, userId)) return
    const id = ghostUserId(this.config, userId)
    const here = this.store.roomGhosts(pair.matrixRoomId).includes(id)
    const count = this.eligibleCount.get(pair.matrixRoomId)
    if (!here && (count === undefined || count >= MAX_GHOSTS_AHEAD)) return
    const check = await this.allowedOrRemoved(pair, userId)
    if (check.mode !== 'ghost' || !check.member || !check.relayAllowed) {
      if (here && this.owns(pair.matrixRoomId)) await this.registry.remove(pair.matrixRoomId, id)
      return
    }
    if (here || this.isCurrent(pair, check.member)) return
    this.eligibleCount.set(pair.matrixRoomId, count! + 1)
    await this.ensure(pair, check.member)
  }
}

function profileKey(member: BridgeMember): string {
  return JSON.stringify([member.display_name || member.username, member.avatar_url])
}
