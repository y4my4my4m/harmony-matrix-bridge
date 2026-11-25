import { z } from 'zod'
import type { Problem } from './BridgeApi.js'
import { httpUrl, localpartSchema, serverNameSchema } from './config.js'
import { endpoint, HttpError, requestJson, type FetchImpl } from './http.js'
import { plainText } from './MatrixClient.js'

const token = z.string().regex(/^[\x21-\x7e]{8,4096}$/)
const hostedSchema = z.object({ bridge_id: z.uuid(), harmony_token: token, homeserver_url: httpUrl.refine(url => url.startsWith('https://')), access_token: token })
const bridgeSchema = z.object({ bridge_id: z.uuid(), harmony_token: token })
const serviceSchema = z.object({ connection: z.literal('application_service'), homeserver_url: httpUrl, server_name: serverNameSchema, sender_localpart: localpartSchema,
  as_token: token, hs_token: token })
const accountSchema = z.object({ connection: z.literal('account'), homeserver_url: httpUrl, access_token: token })

export type HostedEntry = z.infer<typeof hostedSchema>
export type InstanceBridge = z.infer<typeof bridgeSchema>
export type InstanceAccess = z.infer<typeof serviceSchema> | z.infer<typeof accountSchema>
export interface HostList {
  hosted: HostedEntry[]
  /** Null: nothing to run. */
  instance: { access: InstanceAccess; bridges: InstanceBridge[] } | null
}
export interface HostStatus {
  version: string
  instance: { ready: boolean; user_id: string | null; server_name: string | null; problems: Problem[] } | null
  hosted: number
}
export interface LinkedRoom { bridgeId: string; serverName: string; channelName: string }

const MAX_LIST_BYTES = 8 * 1024 * 1024

/** Entries that can be read; one that cannot leaves the others alone. */
function readable<T>(schema: z.ZodType<T>, values: unknown): T[] {
  return (Array.isArray(values) ? values : []).flatMap(value => {
    const parsed = schema.safeParse(value)
    return parsed.success ? [parsed.data] : []
  })
}
function unique<T extends { bridge_id: string }>(entries: T[]): T[] {
  return [...new Map(entries.map(entry => [entry.bridge_id, entry])).values()]
}

/** bot-gateway's `/bridge/v2/matrix/host` routes. */
export class HostApi {
  constructor(private readonly apiBase: string, private readonly secret: string, private readonly fetchImpl?: FetchImpl) {}

  private request<T>(path: string, method: string, body?: unknown): Promise<T> {
    return requestJson<T>(endpoint(this.apiBase, `bridge/v2/matrix/host${path}`), {
      method, headers: { 'X-Bridge-Host-Secret': this.secret, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, this.fetchImpl, 30_000, MAX_LIST_BYTES)
  }

  async list(): Promise<HostList> {
    const body = await this.request<{ hosted?: unknown; instance?: Record<string, unknown> | null } | null>('', 'GET')
    // What a list leaves out is stopped: an answer that is none is refused as a whole.
    if (!Array.isArray(body?.hosted) || typeof body.instance !== 'object') throw new HttpError('Invalid host list', true)
    const access = body.instance === null ? null : z.union([serviceSchema, accountSchema]).safeParse(body.instance)
    if (access && !access.success) throw new HttpError('Invalid host list', true)
    return { hosted: unique(readable(hostedSchema, body.hosted)),
      instance: access ? { access: access.data, bridges: unique(readable(bridgeSchema, body.instance!.bridges)) } : null }
  }

  async status(report: HostStatus): Promise<void> { await this.request('/status', 'POST', report) }

  /** The channel a code belongs to, its room bound by now. */
  async link(code: string, roomId: string, sender: string): Promise<LinkedRoom> {
    const body = await this.request<Record<string, unknown> | null>('/link', 'POST', { code, room_id: roomId, sender })
    if (typeof body?.bridge_id !== 'string') throw new HttpError('Invalid link answer', true)
    return { bridgeId: body.bridge_id, serverName: plainText(body.server_name, 100) ?? 'a Harmony server', channelName: plainText(body.channel_name, 100) ?? 'its channel' }
  }
}
