import { z } from 'zod'
import { ROOM_ID, type Pair } from './config.js'
import { endpoint, HttpError, requestJson, type FetchImpl } from './http.js'
import { plainText, roomAlias, type RoomInfo } from './MatrixClient.js'

export interface ManagedPair {
  channelId: string
  channelName: string | null
  roomId: string | null
  roomAlias: string | null
  direction: Pair['direction']
  senderMode: Pair['senderMode']
  encrypted: boolean
}
export interface ManagedConfig {
  bridgeId: string
  serverId: string
  updatedAt: string
  privacyVersion: string | null
  pairs: ManagedPair[]
}
export interface Redeemed {
  bridge_id: string; server_id: string; harmony_token: string; base_url: string; api_url: string; gateway_url: string
}
export interface OptOutState { optedOut: boolean; source: string | null }
export interface Problem { code: string; detail?: string }
export interface PairReport { channel_id: string; state: 'joining' | 'ready' | 'error'; error: string | null }
export interface StatusReport {
  version: string
  connection: 'application_service' | 'account'
  ready: boolean
  user_id: string | null
  homeserver: string
  server_name: string | null
  pending: number
  failed: number
  rooms: Array<RoomInfo & { invited?: true }>
  pairs: PairReport[]
  problems: Problem[]
}

const pairSchema = z.object({
  channel_id: z.uuid(),
  channel_name: z.string().nullish(),
  room_id: z.string().max(255).regex(ROOM_ID).nullish(),
  room_alias: z.string().nullish(),
  direction: z.enum(['both', 'to_harmony', 'to_matrix']),
  sender_mode: z.enum(['ghost', 'relay']),
  encrypted: z.boolean().nullish(),
})
const configSchema = z.object({
  bridge_id: z.string().min(1),
  server_id: z.string().min(1),
  updated_at: z.string(),
  privacy_version: z.string().nullish(),
  pairs: z.array(z.unknown()).max(10_000),
})
const redeemSchema = z.object({
  bridge_id: z.string().min(1), server_id: z.string().min(1), harmony_token: z.string().regex(/^[\x21-\x7e]{16,512}$/),
  base_url: z.string(), api_url: z.string().min(1), gateway_url: z.string().min(1),
})

// Opt-out lists and configurations grow with the server.
const MAX_LIST_BYTES = 8 * 1024 * 1024
// One erase batch, or a redeem that provisions a token.
const SLOW_MS = 60_000

/** The `/bridge/v2/matrix` routes of bot-gateway. `apiBase` is its root, or its `/api/v1`. */
export class BridgeApi {
  private readonly base: string
  constructor(apiBase: string, private readonly token: string, private readonly fetchImpl?: FetchImpl) {
    this.base = apiBase.replace(/\/+$/, '').replace(/\/api\/v1$/, '')
  }

  static async redeem(apiBase: string, code: string, fetchImpl?: FetchImpl): Promise<Redeemed> {
    const body = await requestJson<unknown>(endpoint(apiBase, 'bridge/v2/matrix/redeem'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    }, fetchImpl, SLOW_MS)
    const parsed = redeemSchema.safeParse(body)
    if (!parsed.success) throw new HttpError('Invalid setup code response', true)
    return parsed.data
  }

  private request<T>(path: string, method: string, body?: unknown, channelId?: string, timeoutMs?: number): Promise<T> {
    const url = endpoint(this.base, `bridge/v2/matrix/${path}`)
    if (channelId) url.searchParams.set('channel_id', channelId)
    return requestJson<T>(url, {
      method, headers: { Authorization: `Bot ${this.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, this.fetchImpl, timeoutMs, MAX_LIST_BYTES)
  }

  async config(): Promise<ManagedConfig> {
    const parsed = configSchema.safeParse(await this.request<unknown>('config', 'GET'))
    if (!parsed.success) throw new HttpError('Invalid bridge configuration', true)
    const pairs: ManagedPair[] = []
    const channels = new Set<string>()
    for (const entry of parsed.data.pairs) {
      const pair = pairSchema.safeParse(entry)
      if (!pair.success || channels.has(pair.data.channel_id)) continue
      const alias = roomAlias(pair.data.room_alias)
      if (!pair.data.room_id && !alias) continue
      channels.add(pair.data.channel_id)
      pairs.push({ channelId: pair.data.channel_id, channelName: plainText(pair.data.channel_name, 100), roomId: pair.data.room_id ?? null,
        roomAlias: alias, direction: pair.data.direction, senderMode: pair.data.sender_mode, encrypted: pair.data.encrypted === true })
    }
    return { bridgeId: parsed.data.bridge_id, serverId: parsed.data.server_id, updatedAt: parsed.data.updated_at,
      privacyVersion: parsed.data.privacy_version ?? null, pairs }
  }

  async status(report: StatusReport): Promise<void> {
    await this.request('status', 'POST', report)
  }

  // `channelId`: the paired channel whose server is meant, for a bot that no managed bridge owns.

  async optOuts(channelId?: string): Promise<{ version: string | null; ids: string[] }> {
    const body = await this.request<{ version?: unknown; remote_user_ids?: unknown }>('privacy/optouts', 'GET', undefined, channelId)
    if (!Array.isArray(body?.remote_user_ids)) throw new HttpError('Invalid opt-out list', true)
    return { version: typeof body.version === 'string' ? body.version : null, ids: body.remote_user_ids.filter((id): id is string => typeof id === 'string') }
  }

  async optOut(userId: string, channelId?: string): Promise<OptOutState> {
    return optOutState(await this.request<unknown>(`privacy/optouts/${encodeURIComponent(userId)}`, 'GET', undefined, channelId))
  }

  async setOptOut(userId: string, optedOut: boolean, channelId?: string): Promise<OptOutState> {
    return optOutState(await this.request<unknown>(`privacy/optouts/${encodeURIComponent(userId)}`, optedOut ? 'PUT' : 'DELETE',
      optedOut ? {} : undefined, channelId))
  }

  /** Opts the person out and deletes their relayed messages. `more`: the gateway finishes in the background. */
  async erase(userId: string, channelId?: string): Promise<{ erased: number; more: boolean }> {
    const body = await this.request<{ erased?: unknown; more?: unknown }>('privacy/erase', 'POST', { user_id: userId }, channelId, SLOW_MS)
    return { erased: typeof body?.erased === 'number' ? body.erased : 0, more: body?.more === true }
  }
}

function optOutState(body: unknown): OptOutState {
  const state = body as { opted_out?: unknown; source?: unknown } | null
  if (typeof state?.opted_out !== 'boolean') throw new HttpError('Invalid opt-out answer', true)
  return { optedOut: state.opted_out, source: typeof state.source === 'string' ? state.source : null }
}
