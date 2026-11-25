import type { BridgeApi, OptOutState } from './BridgeApi.js'
import { HttpError } from './http.js'
import { OptOutList } from './OptOuts.js'

export type PrivacyCommand = 'opt-out' | 'opt-in' | 'status' | 'erase' | 'erase confirm' | 'help'
export type PrivacyApi = Pick<BridgeApi, 'optOuts' | 'optOut' | 'setOptOut' | 'erase'>

const COMMANDS: readonly string[] = ['opt-out', 'opt-in', 'status', 'erase', 'erase confirm']

/** `!bridge-privacy ...` as the whole message; anything after it that is no command reads as help. */
export function parsePrivacyCommand(body: unknown): PrivacyCommand | null {
  if (typeof body !== 'string' || body.length > 200) return null
  const match = /^!bridge-privacy(?:\s+(.*))?$/is.exec(body.trim())
  if (!match) return null
  const words = (match[1] ?? '').trim().toLowerCase().split(/\s+/).join(' ')
  return COMMANDS.includes(words) ? words as PrivacyCommand : 'help'
}

const HELP = '!bridge-privacy opt-out stops your messages from going to Harmony, opt-in lets them through again, status shows which, erase deletes your messages on Harmony. It covers every room bridged to this Harmony server.'
const ERASE_PROMPT = 'This deletes your messages on Harmony, from every room bridged to this Harmony server, and opts you out. Your Matrix messages stay. It cannot be undone. Send !bridge-privacy erase confirm to go ahead.'
export const PRIVACY_FAILED = 'That did not work. Try again in a few minutes.'
const UNAVAILABLE = 'This Harmony does not offer that yet. Ask a manager of the Harmony server.'

function standing(state: OptOutState): string {
  if (!state.optedOut) return 'Your messages go to Harmony. Send !bridge-privacy opt-out to stop that.'
  if (state.source === 'manager' || state.source === 'admin') {
    return 'Your messages do not go to Harmony. The Harmony server\'s managers decided that, and they alone can change it.'
  }
  return 'You are opted out: your messages do not go to Harmony. Send !bridge-privacy opt-in to let them through again.'
}

// Commands a person may send, and replies a room may get, in each window.
const WINDOW_MS = 60_000
const PER_PERSON = 5
const PER_ROOM = 20
const TRACKED = 10_000

export class Allowance {
  private readonly uses = new Map<string, { count: number; until: number }>()
  constructor(private readonly limit: number) {}
  take(key: string, now: number): boolean {
    const current = this.uses.get(key)
    if (current && now < current.until) {
      if (current.count >= this.limit) return false
      current.count++
      return true
    }
    this.uses.delete(key)
    if (this.uses.size >= TRACKED) this.uses.delete(this.uses.keys().next().value!)
    this.uses.set(key, { count: 1, until: now + WINDOW_MS })
    return true
  }
}

export interface PrivacyOptions {
  /** True when one Harmony server is behind every channel and the gateway knows it from the token. */
  oneServer: boolean
  /** False on a gateway without the routes. */
  supported?: boolean
  onChange?: () => void
}

/** Matrix people's own choice about the bridge, kept by Harmony. */
export class PrivacyDesk {
  private readonly lists = new Map<string, OptOutList>()
  private readonly people = new Allowance(PER_PERSON)
  private readonly rooms = new Allowance(PER_ROOM)
  private loads = new Map<string, Promise<void>>()
  supported: boolean

  constructor(private readonly api: PrivacyApi, private readonly options: PrivacyOptions) {
    this.supported = options.supported ?? true
  }

  // With a server per channel unknown, each channel keeps the list of its own server.
  private scope(channelId: string): string { return this.options.oneServer ? '' : channelId }
  private list(channelId: string): OptOutList {
    const scope = this.scope(channelId)
    let list = this.lists.get(scope)
    if (!list) this.lists.set(scope, list = new OptOutList(this.options.onChange))
    return list
  }
  private channel(channelId: string): string | undefined { return this.options.oneServer ? undefined : channelId }

  optedOut(channelId: string, userId: string): boolean {
    return this.lists.get(this.scope(channelId))?.has(userId) ?? false
  }
  /** Harmony refused this author's message. */
  noteOptedOut(channelId: string, userId: string): void { this.list(channelId).add(userId) }
  forget(channelId: string): void { if (!this.options.oneServer) this.lists.delete(channelId) }

  mayAsk(userId: string, now = Date.now()): boolean { return this.people.take(userId, now) }
  mayReply(roomId: string, now = Date.now()): boolean { return this.rooms.take(roomId, now) }

  /** Reads the list unless it is at `version`; one read at a time per server. */
  load(channelId = '', version?: string | null): Promise<void> {
    const scope = this.scope(channelId)
    const running = this.loads.get(scope)
    if (running) return running
    const list = this.list(channelId)
    if (version !== undefined && version === list.version()) return Promise.resolve()
    const load = list.load(async () => {
      const read = await this.api.optOuts(this.channel(channelId))
      return { version: read.version ?? version ?? null, ids: read.ids }
    }).finally(() => { this.loads.delete(scope) })
    this.loads.set(scope, load)
    return load
  }

  /** The answer to the person. Transient failures throw; asking again is safe. */
  async run(channelId: string, userId: string, command: PrivacyCommand): Promise<string> {
    if (command === 'help') return HELP
    if (command === 'erase') return ERASE_PROMPT
    if (!this.supported) return UNAVAILABLE
    const list = this.list(channelId)
    const follow = (state: OptOutState): OptOutState => {
      if (state.optedOut) list.add(userId)
      else list.remove(userId)
      return state
    }
    try {
      switch (command) {
        case 'opt-out': {
          const state = follow(await this.api.setOptOut(userId, true, this.channel(channelId)))
          return state.source === 'manager' || state.source === 'admin' ? standing(state)
            : 'You are opted out: your messages no longer go to Harmony. The ones already there stay; !bridge-privacy erase deletes them.'
        }
        case 'opt-in': {
          // A manager's removal stands, whatever the status of the answer.
          const state = follow(await this.api.setOptOut(userId, false, this.channel(channelId)))
          return state.optedOut ? standing(state) : 'You are opted in: your messages go to Harmony again, from now on. Earlier ones are not copied.'
        }
        case 'status':
          return standing(follow(await this.api.optOut(userId, this.channel(channelId))))
        case 'erase confirm': {
          const { erased, more } = await this.api.erase(userId, this.channel(channelId))
          list.add(userId)
          return `${erased} of your messages on Harmony deleted${more ? '; the rest are being deleted in the background' : ''}. You are opted out: your messages no longer go to Harmony.`
        }
      }
    } catch (error) {
      if (!(error instanceof HttpError)) throw error
      if (error.errcode === 'erase_recent') {
        return `Your messages on Harmony were erased a moment ago. Try again in ${Math.max(1, Math.ceil((error.retryAfterMs ?? WINDOW_MS) / 1000))} seconds.`
      }
      if (error.status === 403 || error.status === 404) return UNAVAILABLE
      throw error
    }
  }
}
