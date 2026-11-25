import { createHash } from 'node:crypto'
import type { LivePair, Pair, RelaySettings } from './config.js'
import { botUserId, ghostOwner, ghostUserId, listAllows } from './config.js'
import { GhostRefused, GhostRegistry, Ghosts } from './Ghosts.js'
import { harmonyToMatrix, matrixToHarmony } from './Mentions.js'
import type { BridgeCheck, BridgeMember, MatrixMember, SenderMode } from './HarmonyClient.js'
import { plainText, roomAlias, type MatrixSendOptions, type RoomMember } from './MatrixClient.js'
import { isRoomCommand, withoutQuote } from './RoomCommand.js'
import { parsePrivacyCommand, PRIVACY_FAILED, type PrivacyCommand, type PrivacyDesk } from './Privacy.js'
import { laneOf, StorageError } from './Store.js'
import type { HeldJobs, Store, Job, NewJob } from './Store.js'
import { HttpError, isTransientError, ResponseTooLarge, type AvatarImage } from './http.js'
import { MAX_MEDIA_BYTES, mediaName, type MediaFile, type MatrixFile } from './Media.js'

type RecordValue = Record<string, unknown>
export interface HarmonyTransport {
  sendMessage(channelId: string, content: string | RecordValue[], metadata: RecordValue, replyTo?: string): Promise<{ id: string }>
  canReplyTo(channelId: string, messageId: string): Promise<boolean>
  /** `named`: the member is wanted whatever the mode. */
  check(channelId: string, userId?: string, named?: boolean): Promise<BridgeCheck>
  uploadBridgeAvatar(channelId: string, image: AvatarImage): Promise<string>
  bridgeMembers(channelId: string): Promise<BridgeMember[]>
  nativeAvatar(channelId: string, userId: string): Promise<AvatarImage>
  publishMatrixMembers(channelId: string, members: MatrixMember[]): void
  downloadFile(channelId: string, messageId: string, index: number): Promise<MediaFile>
  uploadFile(channelId: string, file: MediaFile): Promise<RecordValue>
}
export interface MatrixTransport {
  sendMessage(roomId: string, transactionId: string, body: string, options?: MatrixSendOptions): Promise<{ event_id: string }>
  roomIsPlaintext(roomId: string): Promise<boolean>
  roomMember(roomId: string, userId: string): Promise<{ display_name?: string; avatar_mxc?: string }>
  avatarThumbnail(mxc: string): Promise<AvatarImage>
  registerGhost(id: string, previouslyRegistered: boolean): Promise<void>
  joinGhost(roomId: string, id: string, profile: { displayname: string; avatar_url?: string }): Promise<void>
  leaveGhost(roomId: string, id: string): Promise<void>
  uploadAvatar(image: AvatarImage): Promise<string>
  roomMembers(roomId: string): Promise<RoomMember[]>
  downloadFile(mxc: string, name: string): Promise<MediaFile>
  uploadFile(file: MediaFile): Promise<string>
  sendFile(roomId: string, transactionId: string, file: MatrixFile, options?: MatrixSendOptions): Promise<{ event_id: string }>
}
export interface MatrixEvent extends RecordValue {
  type: string
  event_id?: string
  room_id?: string
  sender?: string
  content?: RecordValue
}

function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
}
function text(value: unknown, max = 16_000): string | null {
  return typeof value === 'string' && value.trim() && value.length <= max ? value : null
}
/** An invite's stripped state. Encryption is checked again after the join. */
export function inviteOf(roomId: string, state: unknown[]): { roomId: string; name: string | null; alias: string | null; encrypted: boolean } {
  const content = (type: string) => record(state.map(record).find(event => event.type === type)?.content)
  return { roomId, name: plainText(content('m.room.name').name, 100), alias: roomAlias(content('m.room.canonical_alias').alias),
    encrypted: state.some(event => record(event).type === 'm.room.encryption') }
}
const MAX_FILES = 20
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MXID = /^@[^\s:]+:[^\s/]+$/
// bot-gateway takes at most this many Matrix members per channel (WebSocketGateway matrixMembers).
const MAX_PUBLISHED_MEMBERS = 1000
// A pair's members without any sign of a change.
const REFRESH_MS = 10 * 60_000
// Membership changes are gathered this long into one refresh.
const GATHER_MS = 30_000
const REFUSED_MS = 60_000
// A room too large to list at each change.
const LARGE_MEMBERSHIP = 1000
// More people than this at once are looked up as a list.
const MAX_RECONCILED = 20
// Lanes (a channel in one direction) that deliver at once.
const MAX_LANES = 4
// Member lists carry the avatars of rooms this small; a larger room's appear once their owner speaks.
const MAX_LISTED_AVATARS = 100
const AVATARS_PER_PASS = 10
const MAX_AVATARS = 2048
const AVATAR_RETRY_MS = 10 * 60_000
// Distinct people one message pings.
const MAX_MENTIONS = 50
// Clock difference accepted between this host and the homeserver that stamped an event.
const CLOCK_SKEW_MS = 5 * 60_000
const MAX_PAUSE_MS = 5 * 60_000
const TOKEN_PAUSE_MS = 60_000
type Attachment = { index: number; name: string; mxc?: string; unavailable?: boolean }
function mediaReference(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 2048
    && /^mxc:\/\/((?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\[[a-fA-F0-9:]+\])(?::[0-9]{1,5})?)\/[a-zA-Z0-9_-]+$/.test(value) ? value : undefined
}
function fileName(value: unknown): string {
  return mediaName(typeof value === 'string' ? (/(?:https?:|mxc:|data:)/i.test(value) ? undefined : value.split(/[?#]/, 1)[0]) : value)
}
function boundedFile(file: MediaFile): MediaFile {
  if (!file || !Buffer.isBuffer(file.bytes) || file.bytes.length > MAX_MEDIA_BYTES
    || typeof file.contentType !== 'string' || file.contentType.length > 127) throw new HttpError('Invalid or oversized media transfer', false)
  return { ...file, name: fileName(file.name) }
}
function oversized(value: unknown): boolean {
  return value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_MEDIA_BYTES)
}
function attachmentNotice(file: Attachment): string {
  return `[Attachment unavailable: ${fileName(file.name)}]`
}
function directionAllows(pair: Pair, direction: Job['direction']): boolean {
  return pair.direction === 'both' || pair.direction === direction
}
function isReady(pair: LivePair): boolean {
  return pair.state === undefined || pair.state === 'ready'
}

export interface RelayOptions {
  privacy?: PrivacyDesk
  /** The Harmony server a channel's copied avatars belong to: bot-gateway stores them per bot and server. */
  avatarScope?: (channelId: string) => string
  /** False for a room whose ghosts leave; default: every room that is not in a pair. */
  keepsGhosts?: (roomId: string) => boolean
  /** Whether the homeserver lets the bridge use ghosts in this channel's room. */
  onGhosts?: (channelId: string, usable: boolean) => void
  /** A paired room turned on encryption; its fence is stored. */
  onEncrypted?: (roomId: string) => void
  /** The bridge's own membership changed in a room. */
  onMembership?: (roomId: string, membership: string) => void
  /** Harmony or the room refused a pair's refresh for good. */
  onRefused?: (channelId: string) => void
  /** Ghost accounts shared with other bridges on the same connection. */
  ghosts?: GhostRegistry
  /** Whether a room's ghosts are this bridge's to remove; default: always. */
  ownsRoom?: (roomId: string) => boolean
  /** False when another cleans up the ghosts of rooms that are no pair's. */
  cleansGhosts?: boolean
}

/** Why a job may not go on, for its record. Nothing failed: no operator is told. */
class Refusal extends HttpError {
  constructor(reason: string) { super(reason, false) }
}

/** `asked`: something changed; otherwise the refresh that comes round by itself. */
interface Wanted { due: number; ghosts: boolean; people: boolean; asked: boolean }

/** One process per database. The queue is durable, but Harmony POST has no idempotency key. */
export class Relay {
  private started = false
  private timer?: ReturnType<typeof setTimeout>
  private ticking?: Promise<void>
  private maintaining = false
  private readonly inFlight = new Set<Promise<void>>()
  /** Lanes with a job, or a refresh, under way. */
  private readonly busy = new Set<string>()
  private delivering = 0
  private healthy = true
  /** Avatar scope and MXC URI; `url` null until `at` after a failed copy. */
  private readonly avatars = new Map<string, { url: string | null; at: number }>()
  private readonly ghosts: Ghosts
  private readonly ghostStore: GhostRegistry['store']
  private readonly wanted = new Map<string, Wanted>()
  private readonly startedAt = Date.now()
  /** Rooms too large to list often, and when each was listed last. */
  private readonly largeRooms = new Map<string, number>()
  /** Harmony members who joined or left, and when their ghosts are looked at. */
  private readonly changedMembers = new Set<string>()
  private membersAt: number | null = null
  private cleanupAt: number | null = null
  private readonly cleanupLater = new Set<string>()
  /** The homeserver's rate limit, or its refusal of the token, epoch ms. Holds Harmony to Matrix only, in order. */
  private matrixPausedUntil = 0
  get isHealthy(): boolean { return this.healthy }
  constructor(
    private readonly config: RelaySettings,
    private readonly store: Store,
    private readonly harmony: HarmonyTransport,
    private readonly matrix: MatrixTransport,
    private readonly report: (message: string) => void = () => {},
    private readonly options: RelayOptions = {},
  ) {
    const registry = options.ghosts ?? new GhostRegistry(store, matrix)
    this.ghostStore = registry.store
    this.ghosts = new Ghosts(config, store, registry, harmony, matrix, options.ownsRoom)
  }

  private pairOfRoom(roomId: unknown): LivePair | undefined {
    return this.config.pairs.find(pair => pair.matrixRoomId === roomId)
  }

  private fences(events: MatrixEvent[]): string[] {
    return events.filter(event => event.type === 'm.room.encryption' && this.pairOfRoom(event.room_id)).map(event => event.room_id!)
  }

  acceptTransaction(transactionId: string, events: MatrixEvent[]): boolean {
    if (!this.healthy) throw new Error('Worker requires restart after storage failure')
    this.noteMemberships(events)
    const fences = this.fences(events)
    const changed = this.store.acceptTransaction(transactionId, this.matrixJobs(events), fences)
    this.accepted(events, fences)
    return changed
  }

  /** The same without a receipt. `history` carries fences and nothing else. */
  acceptEvents(events: MatrixEvent[], history: MatrixEvent[] = []): boolean {
    if (!this.healthy) throw new Error('Worker requires restart after storage failure')
    this.noteMemberships(events)
    const fences = this.fences([...history, ...events])
    const changed = this.store.acceptEvents(this.matrixJobs(events), fences)
    this.accepted([...history, ...events], fences)
    return changed
  }

  /** Fences alone, when the queue has no room for the messages. */
  acceptFences(events: MatrixEvent[]): void {
    const fences = this.fences(events)
    this.store.acceptEvents([], fences)
    this.accepted(events, fences)
  }

  private accepted(events: MatrixEvent[], fences: string[]): void {
    for (const roomId of fences) this.options.onEncrypted?.(roomId)
    this.noteMembers(events)
    this.wake()
  }

  /** One /sync response. `history` carries fences and nothing else; the token commits with both. */
  acceptSync(userId: string, batch: { nextBatch: string; rooms: string[]; events: MatrixEvent[]; history: MatrixEvent[] }): boolean {
    if (!this.healthy) throw new Error('Worker requires restart after storage failure')
    const fences = this.fences([...batch.history, ...batch.events])
    const changed = this.store.acceptSync(userId, batch.nextBatch, batch.rooms, this.matrixJobs(batch.events), fences)
    this.accepted([...batch.history, ...batch.events], fences)
    return changed
  }

  /** People's memberships and profiles in paired rooms, gathered into one refresh; a ghost's own removal at once. */
  private noteMembers(events: MatrixEvent[]): void {
    const own = botUserId(this.config)
    for (const event of events) {
      if (event.type !== 'm.room.member' || typeof event.state_key !== 'string' || event.state_key === own) continue
      const pair = this.pairOfRoom(event.room_id)
      if (!pair) continue
      if (ghostOwner(this.config, event.state_key)) {
        if (['leave', 'ban'].includes(String(record(event.content).membership))) this.ghosts.forget(pair.matrixRoomId, event.state_key)
        continue
      }
      const listed = this.largeRooms.get(pair.matrixRoomId)
      const soon = Date.now() + GATHER_MS
      this.want(pair.harmonyChannelId, listed === undefined ? soon : Math.max(soon, listed + REFRESH_MS), { people: true })
    }
  }

  /** Invites and removals of the bridge's own user, as an application service is told of them. */
  private noteMemberships(events: MatrixEvent[]): void {
    if (!this.options.onMembership) return
    const own = botUserId(this.config)
    for (const event of events) {
      if (event.type !== 'm.room.member' || event.state_key !== own || typeof event.room_id !== 'string') continue
      const membership = String(record(event.content).membership)
      if (membership === 'invite') {
        this.store.saveInvite(inviteOf(event.room_id, Array.isArray(record(event.unsigned).invite_room_state) ? record(event.unsigned).invite_room_state as unknown[] : []))
      } else this.store.dropInvite(event.room_id)
      this.options.onMembership(event.room_id, membership)
    }
  }

  private matrixJobs(events: MatrixEvent[]): NewJob[] {
    const jobs: NewJob[] = []
    for (const event of events) {
      const pair = this.pairOfRoom(event.room_id)
      const content = record(event.content)
      const relation = record(content['m.relates_to'])
      if (!pair || pair.state === 'error') continue
      // Sent before the pair existed: history, whenever the homeserver delivers it.
      if (pair.since !== undefined && typeof event.origin_server_ts === 'number' && event.origin_server_ts < pair.since - CLOCK_SKEW_MS) continue
      if (isRoomCommand(content.body)) continue
      const command = this.privacyCommand(event, content, relation)
      if (command === 'ignored') continue
      if (command) {
        jobs.push({ direction: 'to_harmony', sourceId: event.event_id!, channelId: pair.harmonyChannelId,
          roomId: pair.matrixRoomId, payload: { sender: event.sender, command } })
        continue
      }
      const replyEventId = text(record(relation['m.in_reply_to']).event_id, 255)
      if (content['m.relates_to'] !== undefined && (relation.rel_type !== undefined || !replyEventId || !/^\$\S+$/.test(replyEventId))) continue
      // Old reply fallbacks quote prior content; strip them before text limits or mention parsing.
      const cleanBody = typeof content.body === 'string' ? (replyEventId ? withoutQuote(content.body) : content.body) : ''
      const media = ['m.image', 'm.file', 'm.audio', 'm.video'].includes(String(content.msgtype))
      const name = fileName(content.filename ?? cleanBody)
      const mxc = mediaReference(content.url)
      const files: Attachment[] = media ? [{ index: 0, name,
        ...(content.file === undefined && mxc && !oversized(record(content.info).size) && cleanBody.length <= 16_000
          ? { mxc } : { unavailable: true }) }] : []
      const body = media ? (typeof content.filename === 'string' && cleanBody !== content.filename ? text(cleanBody) || '' : '') : text(cleanBody)
      const formatted = typeof content.formatted_body === 'string' ? (replyEventId
        ? content.formatted_body.replace(/^<mx-reply>[\s\S]*?<\/mx-reply>/i, '') : content.formatted_body) : undefined
      if (!directionAllows(pair, 'to_harmony') || event.type !== 'm.room.message'
        || (!media && content.msgtype !== 'm.text') || !text(event.event_id, 255) || (!body && !files.length)
        || !this.person(event.sender)
        || !listAllows(this.config.matrix.allowedUserIds, event.sender!)
        || this.options.privacy?.optedOut(pair.harmonyChannelId, event.sender!)
        || content['m.new_content']) continue
      jobs.push({ direction: 'to_harmony', sourceId: event.event_id!, channelId: pair.harmonyChannelId,
        roomId: pair.matrixRoomId, payload: { sender: event.sender, body, ...(files.length ? { files } : {}),
          ...(formatted !== undefined && formatted.length <= 32_000 ? { formatted_body: formatted } : {}),
          ...(replyEventId ? { reply_to_event_id: replyEventId } : {}),
          mention_ids: Array.isArray(record(content['m.mentions']).user_ids) ? (record(content['m.mentions']).user_ids as unknown[]).filter(id => typeof id === 'string' && id.length <= 255).slice(0, 100) : [] } })
    }
    return jobs
  }

  /** A Matrix person: neither the bridge itself nor one of its ghosts. */
  private person(sender: unknown): boolean {
    return !!text(sender, 255) && MXID.test(sender as string) && sender !== botUserId(this.config) && !ghostOwner(this.config, sender as string)
  }

  /** `!bridge-privacy`, in or outside a thread; never relayed. 'ignored': asked too often. */
  private privacyCommand(event: MatrixEvent, content: RecordValue, relation: RecordValue): PrivacyCommand | 'ignored' | null {
    if (!this.options.privacy || event.type !== 'm.room.message' || content.msgtype !== 'm.text' || content['m.new_content']
      || relation.rel_type === 'm.replace' || !text(event.event_id, 255) || !this.person(event.sender)) return null
    const body = typeof content.body === 'string' ? content.body : ''
    const command = parsePrivacyCommand(relation['m.in_reply_to'] ? withoutQuote(body) : body)
    return command && !this.options.privacy.mayAsk(event.sender!) ? 'ignored' : command
  }

  acceptHarmonyMessage(message: RecordValue): boolean {
    if (!this.healthy) throw new Error('Worker requires restart after storage failure')
    const pair = this.config.pairs.find(pair => pair.harmonyChannelId === message.channel_id)
    const author = record(message.author)
    const metadata = record(message.metadata)
    if (!pair || pair.state === 'error' || !directionAllows(pair, 'to_matrix') || !text(message.id, 255)
      || message.encrypted === true || message.is_system || message.thread_id
      || author.bot || author.discord_user || message.bot_id
      || metadata.discord_user || metadata.bridge_source || metadata.matrix_relay || metadata.bridge_author
      || !UUID.test(String(author.id)) || !listAllows(this.config.harmony.allowedUserIds, String(author.id))) return false
    const raw = Array.isArray(message.content_raw) ? message.content_raw.map(record) : undefined
    if (raw && raw.length > 1000) return false
    const allFiles: Attachment[] = raw?.flatMap((file, index) => file.type === 'file'
      ? [{ index, name: fileName(file.fileName), ...(oversized(file.fileSize) ? { unavailable: true } : {}) }] : []) || []
    const invalidText = raw?.some(part => part.type === 'text' && (typeof part.text !== 'string' || part.text.length > 16_000))
    if (invalidText && !allFiles.length) return false
    let parts: RecordValue[] | undefined = invalidText ? [{ type: 'text', text: '[Message text unavailable]' }]
      : raw?.filter(part => part.type === 'text' || part.type === 'mention').map(part => part.type === 'text'
        ? { type: 'text', text: part.text as string }
        : { type: 'mention', userId: text(part.userId, 255), username: text(part.username, 100), bridgeSource: part.bridgeSource === 'matrix' ? 'matrix' : undefined, isBridged: part.isBridged === true })
    let body = parts ? text(parts.map(part => part.type === 'text' ? part.text : `@${part.username || 'user'}`).join('')) : text(message.content)
    if (!body && allFiles.length && parts?.some(part => part.type === 'mention' || (typeof part.text === 'string' && part.text.length))) {
      body = '[Message text unavailable]'
      parts = [{ type: 'text', text: body }]
    }
    const files = allFiles.length > MAX_FILES ? [...allFiles.slice(0, MAX_FILES),
      { index: allFiles[MAX_FILES].index, name: `Additional attachments (limit ${MAX_FILES})`, unavailable: true }] : allFiles
    if ((!body && !files.length) || isRoomCommand(body)) return false
    const name = text(author.nickname, 100) || text(author.display_name, 100) || text(author.username, 100) || String(author.id)
    const queued = this.store.enqueue({ direction: 'to_matrix', sourceId: String(message.id),
      channelId: pair.harmonyChannelId, roomId: pair.matrixRoomId,
      payload: { sender: author.id, name, body: body || '', ...(parts ? { parts } : {}), ...(files.length ? { files } : {}) } })
    this.wake()
    return queued
  }

  /** Ghosts of rooms that are no pair's leave. */
  async cleanupUnpairedGhosts(): Promise<void> {
    for (const roomId of this.unpairedRooms()) await this.ghosts.cleanup({ matrixRoomId: roomId }, new Set())
  }

  /** The same, between deliveries, one room at a time. */
  requestGhostCleanup(): void {
    if (this.options.cleansGhosts === false) return
    this.cleanupAt = 0
    this.cleanupLater.clear()
    this.wake()
  }

  private unpairedRooms(): string[] {
    if (this.config.matrix.userId !== undefined) return []
    const keeps = this.options.keepsGhosts ?? (roomId => this.pairOfRoom(roomId) !== undefined)
    return this.ghostStore.ghostRooms().filter(roomId => !keeps(roomId))
  }

  private async cleanupNextRoom(): Promise<void> {
    if (this.cleanupAt === null || Date.now() < this.cleanupAt) return
    const roomId = this.unpairedRooms().find(roomId => !this.cleanupLater.has(roomId))
    if (roomId === undefined) {
      this.cleanupAt = this.cleanupLater.size ? Date.now() + REFUSED_MS : null
      this.cleanupLater.clear()
      return
    }
    try { await this.ghosts.cleanup({ matrixRoomId: roomId }, new Set()) }
    catch (error) {
      if (!(error instanceof HttpError)) throw error
      this.cleanupLater.add(roomId)
      this.report('Ghosts of a removed pair could not leave yet; retrying')
    }
  }

  private want(channelId: string, due: number, what: { ghosts?: boolean; people?: boolean }): void {
    const known = this.wanted.get(channelId)
    // The whole one comes round sooner.
    if (known && !known.asked && known.due <= due) return
    const before = known?.asked ? known : undefined
    this.wanted.set(channelId, { due: Math.min(due, before?.due ?? due), ghosts: (what.ghosts ?? false) || (before?.ghosts ?? false),
      people: (what.people ?? false) || (before?.people ?? false), asked: true })
    this.wake()
  }

  /** Something of the server's configuration changed, opt-outs included: every pair's members, gathered. */
  noteConfiguration(): void {
    for (const pair of this.config.pairs) this.want(pair.harmonyChannelId, Date.now() + GATHER_MS, { ghosts: true, people: true })
  }

  /** Every pair's members, or one channel's, now. */
  requestMemberSync(channelId?: string): void {
    const channels = channelId !== undefined ? [channelId] : this.config.pairs.map(pair => pair.harmonyChannelId)
    for (const id of channels) this.want(id, 0, { ghosts: true, people: true })
  }

  /** Someone joined or left the Harmony server. */
  noteServerMember(userId: string): void {
    if (this.config.matrix.userId !== undefined || !UUID.test(userId)) return
    this.changedMembers.add(userId.toLowerCase())
    this.membersAt ??= Date.now() + GATHER_MS
    this.wake()
  }

  /** Drops what is remembered of a channel that is no pair's anymore. */
  forgetChannel(channelId: string): void {
    this.wanted.delete(channelId)
    // bot-gateway purges a binding's avatars an hour after it ends; a later pair copies them anew.
    this.avatars.clear()
  }

  private wantedOf(pair: LivePair): Wanted {
    return this.wanted.get(pair.harmonyChannelId) ?? { due: this.startedAt + REFRESH_MS, ghosts: true, people: true, asked: false }
  }

  /** Refreshes touch the room's ghosts, as deliveries to it do. */
  private refreshLane(pair: LivePair): string { return laneOf({ direction: 'to_matrix', channelId: pair.harmonyChannelId }) }

  /** The longest due refresh whose lane is free, its lane taken: ahead of the channel's next message. */
  private takeRefresh(now: number): LivePair | undefined {
    let chosen: LivePair | undefined
    for (const pair of this.config.pairs) {
      const { due } = this.wantedOf(pair)
      if (isReady(pair) && due <= now && !this.busy.has(this.refreshLane(pair)) && (!chosen || due < this.wantedOf(chosen).due)) chosen = pair
    }
    if (chosen) this.busy.add(this.refreshLane(chosen))
    return chosen
  }

  private async refresh(pair: LivePair): Promise<void> {
    const channelId = pair.harmonyChannelId
    const what = this.wantedOf(pair)
    this.wanted.delete(channelId)
    let again: Wanted = { due: Date.now() + REFRESH_MS, ghosts: true, people: true, asked: false }
    try {
      const synced = what.ghosts ? await this.ghosts.sync(pair) : null
      if (synced && synced.usable !== null) this.options.onGhosts?.(channelId, synced.usable)
      const listed = what.people ? await this.publishMembers(pair, synced !== null && !synced.prepared) : null
      if (listed && listed.total > LARGE_MEMBERSHIP) this.largeRooms.set(pair.matrixRoomId, Date.now())
      else if (listed) this.largeRooms.delete(pair.matrixRoomId)
      if (synced?.more || listed?.more) again = { due: Date.now(), ghosts: synced?.more ?? false, people: listed?.more ?? false, asked: true }
    } catch (error) {
      if (!(error instanceof HttpError)) throw error
      this.harmony.publishMatrixMembers(channelId, [])
      if (error instanceof ResponseTooLarge) this.largeRooms.set(pair.matrixRoomId, Date.now())
      else {
        again = { due: Date.now() + REFUSED_MS, ghosts: true, people: true, asked: false }
        if (!error.transient) this.options.onRefused?.(channelId)
        this.report('Member refresh refused; check binding, permissions, consent and plaintext policy')
      }
    }
    // What was asked for while it ran stands.
    const asked = this.wanted.get(channelId)
    this.wanted.set(channelId, again)
    if (asked) this.want(channelId, asked.due, asked)
  }

  /** Ghosts of people who joined or left: the one they have in a room, or one ahead of speech. */
  private async reconcileMembers(): Promise<void> {
    if (this.membersAt === null || Date.now() < this.membersAt) return
    const people = [...this.changedMembers]
    this.changedMembers.clear()
    this.membersAt = null
    for (const pair of this.config.pairs) {
      if (!isReady(pair)) continue
      if (people.length > MAX_RECONCILED) { this.want(pair.harmonyChannelId, Date.now(), { ghosts: true }); continue }
      const lane = this.refreshLane(pair)
      if (this.busy.has(lane)) { this.want(pair.harmonyChannelId, Date.now(), { ghosts: true }); continue }
      this.busy.add(lane)
      try { for (const userId of people) await this.ghosts.reconcile(pair, userId) }
      catch (error) {
        if (!(error instanceof HttpError)) throw error
        this.want(pair.harmonyChannelId, Date.now() + REFUSED_MS, { ghosts: true })
      } finally { this.busy.delete(lane) }
    }
  }

  /** `checked`: nothing was awaited since Harmony and the room allowed it but the member list. */
  private async publishMembers(pair: LivePair, checked: boolean): Promise<{ total: number; more: boolean }> {
    if (!checked) await this.ghosts.allowed(pair)
    const joined = await this.matrix.roomMembers(pair.matrixRoomId)
    const members = joined.filter(member => listAllows(this.config.matrix.allowedUserIds, member.id)
      && member.id !== botUserId(this.config) && !ghostOwner(this.config, member.id)
      && !this.options.privacy?.optedOut(pair.harmonyChannelId, member.id)).slice(0, MAX_PUBLISHED_MEMBERS)
    const published: MatrixMember[] = []
    let copies = members.length <= MAX_LISTED_AVATARS ? AVATARS_PER_PASS : 0
    let more = false
    for (const member of members) {
      let avatarUrl: string | undefined
      if (member.avatar_mxc) {
        const known = this.cachedAvatar(pair, member.avatar_mxc)
        if (known !== undefined) avatarUrl = known ?? undefined
        else if (copies > 0) { copies--; avatarUrl = await this.avatarForHarmony(pair, member.avatar_mxc) }
        else if (members.length <= MAX_LISTED_AVATARS) more = true
      }
      const username = member.id.slice(1, member.id.indexOf(':')).slice(0, 100)
      published.push({ id: member.id, username, displayName: member.display_name || username,
        avatarUrl: avatarUrl || null, source: 'matrix' })
    }
    await this.ghosts.allowed(pair)
    this.harmony.publishMatrixMembers(pair.harmonyChannelId, published)
    return { total: joined.length, more }
  }

  private avatarKey(pair: Pair, mxc: string): string {
    return `${this.options.avatarScope?.(pair.harmonyChannelId) ?? pair.harmonyChannelId} ${mxc}`
  }

  /** undefined: not known. null: a copy failed lately. */
  private cachedAvatar(pair: Pair, mxc: string): string | null | undefined {
    const known = this.avatars.get(this.avatarKey(pair, mxc))
    return known && (known.url !== null || Date.now() < known.at + AVATAR_RETRY_MS) ? known.url : undefined
  }

  private async avatarForHarmony(pair: Pair, mxc: string): Promise<string | undefined> {
    const known = this.cachedAvatar(pair, mxc)
    if (known !== undefined) return known ?? undefined
    let image: AvatarImage | undefined
    let url: string | null = null
    try { image = await this.matrix.avatarThumbnail(mxc) } catch { /* Optional thumbnail. */ }
    this.fence(pair.matrixRoomId)
    if (image) {
      try { url = await this.harmony.uploadBridgeAvatar(pair.harmonyChannelId, image) }
      catch { /* Optional avatar upload. */ }
    }
    const key = this.avatarKey(pair, mxc)
    this.avatars.delete(key)
    if (this.avatars.size >= MAX_AVATARS) this.avatars.delete(this.avatars.keys().next().value!)
    this.avatars.set(key, { url, at: Date.now() })
    return url ?? undefined
  }

  start(): void {
    if (this.started || !this.healthy) return
    this.started = true
    this.pump()
  }

  async stop(): Promise<void> {
    this.started = false
    clearTimeout(this.timer)
    this.timer = undefined
    await Promise.all([this.ticking, ...this.inFlight])
  }

  /** Work may have come, or a pair become ready. */
  wake(): void {
    if (this.started) queueMicrotask(() => this.pump())
  }

  private fail(): void {
    this.healthy = false
    this.started = false
    clearTimeout(this.timer)
    this.timer = undefined
    this.report('Storage failure; worker paused and requires restart')
  }

  /** Runs `work` beside the rest; anything that is no transport failure stops the relay with its jobs intact. */
  private run(work: () => Promise<unknown>, after: () => void): void {
    const running: Promise<void> = (async () => { await work() })().catch(() => this.fail()).finally(() => {
      this.inFlight.delete(running)
      after()
      this.pump()
    })
    this.inFlight.add(running)
  }

  private held(now: number): HeldJobs {
    return { direction: now < this.matrixPausedUntil ? 'to_matrix' : undefined,
      channels: this.config.pairs.filter(pair => pair.state === 'joining').map(pair => pair.harmonyChannelId),
      lanes: [...this.busy] }
  }

  private pump(): void {
    if (!this.started || !this.healthy) return
    clearTimeout(this.timer)
    this.timer = undefined
    try {
      const now = Date.now()
      if (!this.maintaining) {
        const pair = this.takeRefresh(now)
        if (pair || this.maintenanceAt() <= now) {
          this.maintaining = true
          this.run(() => this.maintain(pair), () => { this.maintaining = false })
        }
      }
      while (this.delivering < MAX_LANES) {
        const job = this.store.nextJob(now, this.held(now))
        if (!job) break
        const lane = laneOf(job)
        this.busy.add(lane)
        this.delivering++
        this.run(() => this.deliver(job), () => { this.busy.delete(lane); this.delivering-- })
      }
      const next = Math.min(this.maintaining ? Infinity : this.maintenanceAt(), now < this.matrixPausedUntil ? this.matrixPausedUntil : Infinity, this.store.nextReadyAt(now) ?? Infinity)
      // A minute at most, in case the clock was set.
      this.timer = setTimeout(() => this.pump(), Math.max(1, Math.min(60_000, next - now)))
    } catch { this.fail() }
  }

  /** When a cleanup, a refresh or a look at joined and departed members is due, epoch ms. */
  private maintenanceAt(): number {
    let at = Math.min(this.cleanupAt ?? Infinity, this.membersAt ?? Infinity)
    for (const pair of this.config.pairs) if (isReady(pair) && !this.busy.has(this.refreshLane(pair))) at = Math.min(at, this.wantedOf(pair).due)
    return at
  }

  /** One step of each kind. `pair`: from takeRefresh. */
  private async maintain(pair: LivePair | undefined): Promise<void> {
    if (pair) {
      try { await this.refresh(pair) }
      finally { this.busy.delete(this.refreshLane(pair)) }
      this.wake()
    }
    await this.cleanupNextRoom()
    await this.reconcileMembers()
  }

  /** One step: maintenance that is due, then one job. A started relay takes its own. */
  async tick(): Promise<void> {
    if (this.ticking) return this.ticking
    if (!this.healthy) return
    this.ticking = (async () => {
      await this.maintain(this.takeRefresh(Date.now()))
      const now = Date.now()
      const job = this.store.nextJob(now, this.held(now))
      if (!job) return
      const lane = laneOf(job)
      this.busy.add(lane)
      try { await this.deliver(job) } finally { this.busy.delete(lane) }
    })().catch(() => this.fail())
    try { await this.ticking } finally { this.ticking = undefined }
  }

  /** The pair a job may still go through, and its sender; refused otherwise. Asks nobody. */
  private standing(job: Job): LivePair {
    const pair = this.config.pairs.find(pair => pair.harmonyChannelId === job.channelId && pair.matrixRoomId === job.roomId)
    const sender = String(job.payload.sender)
    const permitted = job.direction === 'to_matrix'
      ? UUID.test(sender) && listAllows(this.config.harmony.allowedUserIds, sender)
      : listAllows(this.config.matrix.allowedUserIds, sender)
    if (!pair || !isReady(pair) || !directionAllows(pair, job.direction) || !permitted) throw new Refusal('Pair or sender is no longer permitted')
    if (job.direction === 'to_harmony' && this.options.privacy?.optedOut(job.channelId, sender)) throw new Refusal('Author opted out of the bridge')
    return pair
  }

  /** A fence read that fails is a storage fault, never a refusal. */
  private fence(roomId: string): void {
    let blocked: boolean
    try { blocked = this.store.isRoomBlocked(roomId) }
    catch { throw new StorageError('Encryption fence could not be read') }
    if (blocked) throw new Refusal('Encrypted channels and rooms are not supported')
  }

  /** Harmony's side of a send: binding, room, encryption, and for a member's message their consent. */
  private async harmonyAllows(job: Job): Promise<BridgeCheck & { mode: SenderMode }> {
    const sender = job.direction === 'to_matrix' ? String(job.payload.sender) : undefined
    const check = await this.harmony.check(job.channelId, sender)
    if (!check.registered || check.mode === null) throw new HttpError('Channel is not registered to this Matrix bridge', false)
    if (check.roomId !== job.roomId) throw new HttpError('Matrix room binding differs from configuration', false)
    if (!check.plaintext) throw new Refusal('Encrypted channels and rooms are not supported')
    if (sender !== undefined && check.relayAllowed !== true) throw new Refusal('Member has not allowed relay')
    return { ...check, mode: this.config.matrix.userId !== undefined ? 'relay' : check.mode }
  }

  private async matrixAllows(job: Job): Promise<void> {
    if (!await this.matrix.roomIsPlaintext(job.roomId)) throw new Refusal('Encrypted channels and rooms are not supported')
  }

  private senderFor(mode: SenderMode, userId: string): string {
    return mode === 'ghost' ? ghostUserId(this.config, userId) : botUserId(this.config)
  }

  /** Asks nobody: what this process knows by now. In the same turn as the send. */
  private stillGoes(job: Job): void {
    this.standing(job)
    this.fence(job.roomId)
  }

  /**
   * Everything a send depends on, the destination last; the caller sends without awaiting anything more.
   * Neither API offers an atomic check-and-send, so a residual race remains on the servers' side (see
   * README); the durable fence covers Matrix encryption between the two checks.
   */
  private async mayGo(job: Job, matrixSender?: string): Promise<BridgeCheck & { mode: SenderMode }> {
    let check: BridgeCheck & { mode: SenderMode }
    if (job.direction === 'to_matrix') {
      check = await this.harmonyAllows(job)
      if (matrixSender !== this.senderFor(check.mode, String(job.payload.sender))) throw new HttpError('Matrix sender mode changed during delivery', false)
      if (check.mode === 'ghost' && !check.member) throw new HttpError('Ghost sender is not an eligible allowlisted member', false)
      await this.matrixAllows(job)
    } else {
      await this.matrixAllows(job)
      check = await this.harmonyAllows(job)
    }
    this.stillGoes(job)
    return check
  }

  private async deliver(job: Job): Promise<void> {
    if (job.direction === 'to_harmony' && job.payload.command !== undefined) return this.answerCommand(job)
    let pair: LivePair
    try { pair = this.standing(job) }
    catch (error) { this.deliveryFailure(job, error, false); return }
    const files = Array.isArray(job.payload.files) && job.payload.files.length <= MAX_FILES + 1 ? job.payload.files.map(record) as Attachment[] : []
    const body = text(job.payload.body) || ''
    if ((job.payload.files !== undefined && (!Array.isArray(job.payload.files) || job.payload.files.length > MAX_FILES + 1))
      || (job.direction === 'to_harmony' && files.length > 1) || (!body && !files.length)
      || files.some(file => !Number.isSafeInteger(file.index) || file.index < 0 || file.index >= 1000
        || typeof file.name !== 'string' || file.name !== fileName(file.name)
        || (file.unavailable !== undefined && file.unavailable !== true)
        || ((job.direction === 'to_matrix' || file.unavailable) ? file.mxc !== undefined : !mediaReference(file.mxc)))) {
      this.store.fail(job.id, 'Invalid queued payload')
      return
    }
    // Storage operations live outside transport catches: disk failures must pause the worker with the
    // job intact, never masquerade as a refused remote delivery.
    const destination = job.direction === 'to_harmony' ? await this.toHarmony(job, pair, body, files) : await this.toMatrix(job, pair, body, files)
    if (destination !== null) this.store.complete(job.id, destination)
  }

  /** The copy's ID; null when the job was failed or put off. */
  private async toHarmony(job: Job, pair: LivePair, body: string, files: Attachment[]): Promise<string | null> {
    const sender = String(job.payload.sender)
    const replyEventId = text(job.payload.reply_to_event_id, 255)
    let replyTo = replyEventId ? this.store.findMapping('to_harmony', replyEventId, job.channelId, job.roomId)
      ?? this.store.findSource('to_matrix', replyEventId, job.channelId, job.roomId) ?? undefined : undefined
    const author: RecordValue = { platform: 'matrix', id: sender, username: sender.slice(1, sender.indexOf(':')).slice(0, 100) }
    let parts: RecordValue[] | undefined
    let writing = false
    try {
      if (!text(sender, 255) || !MXID.test(sender)) throw new HttpError('Invalid Matrix sender', false)
      await this.harmonyAllows(job)
      await this.matrixAllows(job)
      this.fence(job.roomId)
      const member = await this.matrix.roomMember(job.roomId, sender)
      this.fence(job.roomId)
      if (member.display_name) author.display_name = member.display_name
      if (member.avatar_mxc) {
        // Avatars are optional; a fence raised during the copy still blocks the message.
        const url = await this.avatarForHarmony(pair, member.avatar_mxc)
        if (url) author.avatar_url = url
      }
      if (replyTo && !await this.harmony.canReplyTo(job.channelId, replyTo)) replyTo = undefined
      parts = await this.mentionParts(job, pair, body)
      if (files.length) {
        parts ||= body ? [{ type: 'text', text: body }] : []
        for (const descriptor of files) {
          let part: RecordValue | undefined
          if (!descriptor.unavailable && descriptor.mxc) {
            const file = await this.mediaStep(job, undefined, async () => boundedFile(await this.matrix.downloadFile(descriptor.mxc!, descriptor.name)))
            if (file) part = await this.mediaStep(job, undefined, () => this.harmony.uploadFile(job.channelId, file))
          }
          parts.push(part || { type: 'text', text: `${parts.length ? '\n' : ''}${attachmentNotice(descriptor)}` })
        }
        if (replyTo && !await this.harmony.canReplyTo(job.channelId, replyTo)) replyTo = undefined
      }
      await this.mayGo(job)
      this.stillGoes(job)
      writing = true
      const result = await this.harmony.sendMessage(job.channelId, parts || body, {
        bridge_author: author,
        matrix_relay: { room_id: job.roomId, event_id: job.sourceId, sender },
      }, replyTo)
      return result.id
    } catch (error) {
      this.deliveryFailure(job, error, writing)
      return null
    }
  }

  private async mentionParts(job: Job, pair: LivePair, body: string): Promise<RecordValue[] | undefined> {
    const ids = Array.isArray(job.payload.mention_ids) ? job.payload.mention_ids : []
    const named = body.startsWith('!mention ')
    if (!ids.length && !named) return undefined
    const owned = ids.filter((id): id is string => typeof id === 'string' && this.ghostStore.ownsGhost(id)).slice(0, MAX_MENTIONS)
    let members: BridgeMember[] = []
    if (named) members = await this.ghosts.eligible(pair)
    else for (const id of owned) {
      const member = await this.eligibleMember(pair, ghostOwner(this.config, id))
      if (member) members.push(member)
    }
    return matrixToHarmony(body, job.payload.formatted_body, owned, members, this.config)
  }

  /** One Harmony member who may be named on Matrix. */
  private async eligibleMember(pair: LivePair, userId: string | null): Promise<BridgeMember | null> {
    if (userId === null || !listAllows(this.config.harmony.allowedUserIds, userId)) return null
    const check = await this.harmony.check(pair.harmonyChannelId, userId, true)
    return check.registered && check.relayAllowed === true ? check.member : null
  }

  private async toMatrix(job: Job, pair: LivePair, body: string, files: Attachment[]): Promise<string | null> {
    const sender = String(job.payload.sender)
    const transactionId = createHash('sha256').update(JSON.stringify([job.channelId, job.roomId, job.sourceId])).digest('hex')
    let destinationId: string | null = null
    try {
      const check = await this.harmonyAllows(job)
      await this.matrixAllows(job)
      this.fence(job.roomId)
      const matrixSender = this.store.freezeSender(job, this.senderFor(check.mode, sender))
      if (matrixSender !== this.senderFor(check.mode, sender)) throw new HttpError('Queued Matrix sender is frozen; administrator mode changed', false)
      const ghost = check.mode === 'ghost'
      if (ghost) {
        if (!check.member) throw new HttpError('Ghost sender is not an eligible allowlisted member', false)
        if (!this.ghosts.isCurrent(pair, check.member)) await this.prepareGhost(job, pair, check.member)
      }
      const jobParts = Array.isArray(job.payload.parts) ? job.payload.parts.map(record) : undefined
      const targets = await this.mentionTargets(pair, check.mode, jobParts)
      const outbound = harmonyToMatrix(jobParts, body, targets, ghost ? '' : `[${job.payload.name} · Harmony] `)
      // A ghost that was removed from the room is prepared once more, under checks of its own.
      let prepared = false
      const sending = async <T>(send: () => Promise<T>): Promise<T> => {
        this.stillGoes(job)
        try { return await send() }
        catch (error) {
          if (!ghost || prepared || !(error instanceof HttpError) || error.status !== 403) throw error
          prepared = true
          this.ghosts.forget(job.roomId, matrixSender)
          await this.prepareGhost(job, pair, check.member!)
          await this.mayGo(job, matrixSender)
          this.stillGoes(job)
          return send()
        }
      }
      if (body || outbound.body.trim()) {
        await this.mayGo(job, matrixSender)
        const result = await sending(() => this.matrix.sendMessage(job.roomId, transactionId, outbound.body, {
          sender: matrixSender, userIds: outbound.userIds, formattedBody: outbound.formattedBody,
        }))
        if (files.length) this.store.recordDestination(job, result.event_id)
        destinationId = result.event_id
      }
      for (const descriptor of files) {
        const fileTransaction = `${transactionId}.file-${descriptor.index}`
        let fileResult: { event_id: string } | undefined
        if (!descriptor.unavailable) {
          const file = await this.mediaStep(job, matrixSender, async () => boundedFile(await this.harmony.downloadFile(job.channelId, job.sourceId, descriptor.index)))
          if (file) {
            const mxc = await this.mediaStep(job, matrixSender, () => this.matrix.uploadFile(file))
            if (mxc) fileResult = await this.mediaStep(job, matrixSender, () => sending(() => this.matrix.sendFile(job.roomId, fileTransaction,
              { mxc, name: fileName(file.name), contentType: file.contentType, size: file.bytes.length }, { sender: matrixSender })))
          }
        }
        if (!fileResult) {
          await this.mayGo(job, matrixSender)
          fileResult = await sending(() => this.matrix.sendMessage(job.roomId, fileTransaction, attachmentNotice(descriptor), { sender: matrixSender }))
        }
        this.store.recordDestination(job, fileResult.event_id)
        destinationId ??= fileResult.event_id
      }
      return destinationId
    } catch (error) {
      this.deliveryFailure(job, error, false)
      return null
    }
  }

  private async prepareGhost(job: Job, pair: LivePair, member: BridgeMember): Promise<void> {
    try { await this.ghosts.ensure(pair, member) }
    catch (error) {
      if (error instanceof GhostRefused) this.options.onGhosts?.(job.channelId, false)
      throw error
    }
    this.options.onGhosts?.(job.channelId, true)
  }

  /** Who a Harmony message's mention parts ping on Matrix: allowed people and eligible members' ghosts, joined to the room. */
  private async mentionTargets(pair: LivePair, mode: SenderMode, parts: RecordValue[] | undefined): Promise<Map<string, string>> {
    const targets = new Map<string, string>()
    const ids = [...new Set(parts?.filter(part => part.type === 'mention' && typeof part.userId === 'string').map(part => part.userId as string))]
    for (const id of ids.slice(0, MAX_MENTIONS)) {
      let target: string
      if (id.startsWith('@')) {
        if (!this.person(id) || !listAllows(this.config.matrix.allowedUserIds, id)
          || this.options.privacy?.optedOut(pair.harmonyChannelId, id)) continue
        target = id
      } else {
        if (mode !== 'ghost' || !UUID.test(id)) continue
        target = ghostUserId(this.config, id)
        if (!this.ghostStore.ownsGhost(target) || !await this.eligibleMember(pair, id)) continue
      }
      try { await this.matrix.roomMember(pair.matrixRoomId, target) }
      catch (error) {
        if (error instanceof HttpError && !error.transient) continue
        throw error
      }
      targets.set(id, target)
    }
    return targets
  }

  /** The privacy command's answer goes to the room, addressed to who asked: Matrix has no reply only they see. */
  private async answerCommand(job: Job): Promise<void> {
    const sender = String(job.payload.sender)
    const privacy = this.options.privacy
    const command = parsePrivacyCommand(`!bridge-privacy ${String(job.payload.command)}`)
    const paired = () => {
      if (!this.config.pairs.some(pair => pair.harmonyChannelId === job.channelId && pair.matrixRoomId === job.roomId && isReady(pair))) throw new Refusal('Pair or sender is no longer permitted')
      this.fence(job.roomId)
    }
    if (!privacy || !command || !this.person(sender)) {
      this.store.fail(job.id, 'Invalid queued payload')
      return
    }
    try {
      paired()
      // The command is the person's own; a channel or room that encrypts stops the answer, not their choice.
      const check = await this.harmony.check(job.channelId)
      if (!check.registered) throw new HttpError('Channel is not registered to this Matrix bridge', false)
      let reply: string
      try { reply = await privacy.run(job.channelId, sender, command) }
      catch (error) {
        if (!(error instanceof HttpError) || (error.transient && job.attempts < 7)) throw error
        reply = PRIVACY_FAILED
      }
      if (!privacy.mayReply(job.roomId)) {
        this.store.finish(job.id)
        return
      }
      const transactionId = createHash('sha256').update(JSON.stringify(['privacy', job.channelId, job.roomId, job.sourceId])).digest('hex')
      await this.harmonyAllows(job)
      await this.matrixAllows(job)
      paired()
      await this.matrix.sendMessage(job.roomId, transactionId, reply, { notice: true, userIds: [sender], replyTo: job.sourceId })
    } catch (error) {
      this.deliveryFailure(job, error, false)
      return
    }
    this.store.finish(job.id)
  }

  private async mediaPolicy(job: Job, matrixSender: string | undefined): Promise<void> {
    this.stillGoes(job)
    // The author is still in the room whose file is copied.
    if (job.direction === 'to_harmony') await this.matrix.roomMember(job.roomId, String(job.payload.sender))
    await this.mayGo(job, matrixSender)
  }

  private async mediaStep<T>(job: Job, matrixSender: string | undefined, transfer: () => Promise<T>): Promise<T | undefined> {
    await this.mediaPolicy(job, matrixSender)
    let failure: unknown
    // Only the transport is caught; policy/storage failures must never become attachment notices.
    try { return await transfer() }
    catch (error) { if (error instanceof StorageError || error instanceof Refusal) throw error; failure = error }
    await this.mediaPolicy(job, matrixSender)
    if (isTransientError(failure) && job.attempts < 7) throw failure
    return undefined
  }

  private deliveryFailure(job: Job, error: unknown, harmonyWriteStarted: boolean): void {
    if (error instanceof StorageError) throw error
    if (error instanceof Refusal) { this.store.fail(job.id, error.message); return }
    if (error instanceof HttpError && error.errcode === 'BRIDGE_AUTHOR_OPTED_OUT' && job.direction === 'to_harmony') {
      this.options.privacy?.noteOptedOut(job.channelId, String(job.payload.sender))
      this.store.fail(job.id, 'Author opted out of the bridge')
      return
    }
    // A rate limit or a refused token spends no attempt: the messages behind this one meet the same.
    if (job.direction === 'to_matrix' && error instanceof HttpError
      && (error.status === 429 || error.errcode === 'M_UNKNOWN_TOKEN' || error.errcode === 'M_MISSING_TOKEN')) {
      const delay = error.status === 429 ? Math.max(1000, error.retryAfterMs ?? 1000) : TOKEN_PAUSE_MS
      this.matrixPausedUntil = Date.now() + Math.min(MAX_PAUSE_MS, delay)
      return
    }
    // Never persist arbitrary exception text: it may contain access tokens or message content.
    // Only a rate-limit rejection is known to occur before the Harmony handler runs.
    // Network errors/5xx after starting its non-idempotent POST are never blindly retried.
    const retrySafe = !harmonyWriteStarted || (error instanceof HttpError && error.status === 429)
    if (retrySafe && isTransientError(error) && job.attempts < 7) {
      const delay = Math.max(Math.min(60_000, 1000 * 2 ** job.attempts), error instanceof HttpError ? error.retryAfterMs ?? 0 : 0)
      this.store.retry(job.id, 'Transient delivery failure', delay)
      this.report('Delivery delayed; retry scheduled')
    } else {
      this.store.fail(job.id, harmonyWriteStarted ? 'Harmony send failed or outcome uncertain; not retried' : 'Delivery refused or retry limit reached')
      this.report('Delivery failed; inspect permissions, encryption and connectivity')
    }
  }
}
