import { createHash } from 'node:crypto'
import type { HostApi } from './HostApi.js'
import type { HostStore } from './HostStore.js'
import { HttpError } from './http.js'
import type { MatrixClient } from './MatrixClient.js'
import { Allowance } from './Privacy.js'
import type { MatrixEvent } from './Relay.js'
import { isRoomCommand, roomCode } from './RoomCommand.js'

// Commands worked on at once; more are dropped, and their senders can post them again.
const MAX_RUNNING = 20
const NOTICES_PER_ROOM = 20
const WHERE = 'Harmony: Server settings, Bridges, Matrix'
export const ENCRYPTED_ROOM = 'This room is end-to-end encrypted. The bridge cannot read it, so it cannot be linked with Harmony. Use a room without encryption.'

export interface RoomLinksOptions {
  matrix: Pick<MatrixClient, 'sendMessage' | 'roomMember' | 'mayChangeRoom' | 'roomIsPlaintext'>
  api: Pick<HostApi, 'link'>
  store: Pick<HostStore, 'takeTry'>
  /** Neither the bridge itself nor one of its ghosts. */
  isPerson: (userId: string) => boolean
  onLinked: (roomId: string, bridgeId: string) => void
  onEncrypted: (roomId: string) => void
  /** Harmony's public address, for what people are told. */
  publicUrl: string | null
  report: (line: string) => void
}

/** `!harmony link ML-…` in a room the instance's account is in. The code goes to Harmony and nowhere else. */
export class RoomLinks {
  private readonly running = new Set<Promise<void>>()
  private readonly notices = new Allowance(NOTICES_PER_ROOM)
  constructor(private readonly options: RoomLinksOptions) {}

  /** Commands among the events; they are worked on beside the rest. */
  take(events: MatrixEvent[]): void {
    for (const event of events) {
      const { content } = event
      if (event.type !== 'm.room.message' || content?.msgtype !== 'm.text' || content['m.new_content'] || !isRoomCommand(content.body)) continue
      if (typeof event.event_id !== 'string' || typeof event.room_id !== 'string' || typeof event.sender !== 'string' || !this.options.isPerson(event.sender)) continue
      if (this.running.size >= MAX_RUNNING) return
      const run: Promise<void> = this.run(event.event_id, event.room_id, event.sender, content.body as string).catch(() => {
        this.options.report('A room could not be linked; check the homeserver and local storage')
      }).finally(() => { this.running.delete(run) })
      this.running.add(run)
    }
  }

  async settled(): Promise<void> { await Promise.all(this.running) }

  private async run(eventId: string, roomId: string, sender: string, body: string): Promise<void> {
    const { matrix, api, store, onLinked, onEncrypted } = this.options
    if (store.takeTry(eventId, sender) !== 'taken') return
    const say = (text: string) => this.say(eventId, roomId, sender, text)
    if (!await matrix.roomIsPlaintext(roomId)) return onEncrypted(roomId)
    // Who left by now, or was never in the room, decides nothing there.
    await matrix.roomMember(roomId, sender)
    if (!await matrix.mayChangeRoom(roomId, sender)) return say('Only someone who may change this room\'s settings can link it with Harmony.')
    const code = roomCode(body)
    if (!code) return say(`To link this room with a Harmony channel, get a code in ${this.where()} and post !harmony link followed by the code.`)
    try {
      const linked = await api.link(code, roomId, sender)
      onLinked(roomId, linked.bridgeId)
      await say(`This room is now linked with #${linked.channelName} on ${linked.serverName}.`)
    } catch (error) {
      if (!(error instanceof HttpError)) throw error
      if (error.errcode === 'invalid_code') return say(`That code is not valid. A code works once, for 30 minutes. Get a new one in ${this.where()}.`)
      if (error.errcode === 'channel_encrypted') return say('That Harmony channel is end-to-end encrypted, so it cannot be linked.')
      return say('Harmony could not be reached, so the room is not linked. Post the command again in a minute.')
    }
  }

  private where(): string { return this.options.publicUrl ? `${WHERE} (${this.options.publicUrl})` : WHERE }

  private async say(eventId: string, roomId: string, sender: string, text: string): Promise<void> {
    if (!this.notices.take(roomId, Date.now())) return
    const transactionId = createHash('sha256').update(JSON.stringify(['link', roomId, eventId])).digest('hex')
    try { await this.options.matrix.sendMessage(roomId, transactionId, text, { notice: true, userIds: [sender], replyTo: eventId }) }
    catch (error) {
      if (!(error instanceof HttpError)) throw error
      this.options.report('An answer about linking a room could not be posted there')
    }
  }
}
