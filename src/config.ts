import { readFileSync } from 'node:fs'
import { z } from 'zod'

export const DEFAULT_LOCALPART = 'harmony_relay'
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}
// A refinement runs on a value z.url() refuses too.
export const httpUrl = z.string().refine(isHttpUrl, 'Expected an HTTP(S) URL without credentials, query or fragment')
const matrixId = z.string().max(255).regex(/^@[^\s:\u0000-\u001f\u007f]+:[^\s/\u0000-\u001f\u007f]+$/)
export const serverNameSchema = z.string().regex(/^[a-zA-Z0-9.-]+(?::[0-9]+)?$/)
export const localpartSchema = z.string().regex(/^[a-z0-9._=-]+$/)
// Room IDs are opaque: room version 12+ IDs need not contain a homeserver suffix.
export const ROOM_ID = /^![^\s/\u0000-\u001f\u007f]+$/
const pairSchema = z.object({
  harmonyChannelId: z.uuid(),
  matrixRoomId: z.string().min(2).max(255).regex(ROOM_ID),
  direction: z.enum(['both', 'to_harmony', 'to_matrix']).default('both'),
  senderMode: z.enum(['ghost', 'relay']).default('relay'),
}).strict()

export const configSchema = z.object({
  harmony: z.object({
    apiUrl: httpUrl,
    gatewayUrl: z.url().refine(value => {
      const url = new URL(value)
      return ['ws:', 'wss:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
    }),
    // An additional source restriction, never a substitute for native per-member consent. Absent: every member.
    allowedUserIds: z.array(z.uuid()).min(1).max(1000).optional(),
  }).strict(),
  matrix: z.object({
    homeserverUrl: httpUrl,
    serverName: serverNameSchema,
    senderLocalpart: localpartSchema.default(DEFAULT_LOCALPART),
    applicationServiceUrl: httpUrl,
    // Absent: every Matrix person who has not opted out.
    allowedUserIds: z.array(matrixId).min(1).max(1000).optional(),
  }).strict(),
  listen: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(0).max(65535).default(9009),
  }).strict().default({ host: '127.0.0.1', port: 9009 }),
  database: z.string().min(1).default('./data/bridge.sqlite'),
  pairs: z.array(pairSchema).min(1).max(100),
}).strict().superRefine((config, context) => {
  for (const field of ['harmonyChannelId', 'matrixRoomId'] as const) {
    const values = config.pairs.map(pair => pair[field])
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: `Each ${field} may be paired only once`, path: ['pairs'] })
    }
  }
})

export type Config = z.infer<typeof configSchema>
export type Pair = Config['pairs'][number]
/** `state` absent: ready. A joining pair takes events and delivers none; an error pair takes fences only. */
export interface LivePair extends Pair {
  state?: 'joining' | 'ready' | 'error'
  /** Epoch ms. Matrix events sent before the pair existed are history and stay out. */
  since?: number
}
/** `userId` set: an ordinary account, without ghosts; otherwise an application service. */
export interface MatrixIdentity { serverName: string; senderLocalpart?: string; userId?: string }
/** What the relay reads, live, on every event and job. A parsed Config is one. */
export interface RelaySettings {
  readonly pairs: readonly LivePair[]
  readonly harmony: { readonly allowedUserIds?: readonly string[] }
  readonly matrix: MatrixIdentity & { readonly allowedUserIds?: readonly string[] }
}
export interface Secrets { harmonyToken: string; asToken: string; hsToken: string }

export function listAllows(list: readonly string[] | undefined, id: string): boolean {
  return list === undefined || list.includes(id)
}

export function loadConfig(path: string): Config {
  // Do not print parser input: config may contain personal user/room IDs.
  try { return configSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) }
  catch { throw new Error('Invalid bridge configuration; check config.example.json and the documented schema') }
}

export function loadSecrets(env: NodeJS.ProcessEnv = process.env): Secrets {
  const harmonyToken = env.HARMONY_TOKEN ?? ''
  const asToken = env.MATRIX_AS_TOKEN ?? ''
  const hsToken = env.MATRIX_HS_TOKEN ?? ''
  if (!/^harmony_bot_[a-f0-9]{64}$/.test(harmonyToken)) throw new Error('HARMONY_TOKEN must be a Harmony bot token')
  checkServiceTokens(asToken, hsToken)
  return { harmonyToken, asToken, hsToken }
}

export function checkServiceTokens(asToken: string, hsToken: string): void {
  if (!/^[a-zA-Z0-9_-]{32,}$/.test(asToken) || !/^[a-zA-Z0-9_-]{32,}$/.test(hsToken) || asToken === hsToken) {
    throw new Error('MATRIX_AS_TOKEN and MATRIX_HS_TOKEN must be distinct random tokens of at least 32 URL-safe characters')
  }
}

type Identified = { matrix: MatrixIdentity }

export function botUserId(config: Identified): string {
  return config.matrix.userId ?? `@${config.matrix.senderLocalpart}:${config.matrix.serverName}`
}

export function ghostUserId(config: Identified, harmonyId: string): string {
  if (config.matrix.userId !== undefined) throw new Error('An ordinary account has no ghosts')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(harmonyId)) throw new Error('Invalid ghost owner UUID')
  const id = `@${config.matrix.senderLocalpart}_h_${harmonyId.replaceAll('-', '').toLowerCase()}:${config.matrix.serverName}`
  if (id.length > 255) throw new Error('Ghost MXID exceeds Matrix limit')
  return id
}

export function ghostOwner(config: Identified, matrixId: string): string | null {
  if (config.matrix.userId !== undefined) return null
  const prefix = `@${config.matrix.senderLocalpart}_h_`
  const suffix = `:${config.matrix.serverName}`
  if (!matrixId.startsWith(prefix) || !matrixId.endsWith(suffix)) return null
  const hex = matrixId.slice(prefix.length, -suffix.length)
  return /^[0-9a-f]{32}$/.test(hex) ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : null
}

export function registration(
  config: { matrix: { serverName: string; senderLocalpart: string; applicationServiceUrl: string } }, secrets: Pick<Secrets, 'asToken' | 'hsToken'>,
): Record<string, unknown> {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const escaped = escape(botUserId(config))
  const ghostNamespace = `^@${escape(config.matrix.senderLocalpart)}_h_[0-9a-f]{32}:${escape(config.matrix.serverName)}$`
  return {
    // Registration ids are unique per homeserver; the default sender keeps its released id.
    id: config.matrix.senderLocalpart === DEFAULT_LOCALPART ? 'harmony-matrix-relay' : `harmony-matrix-relay-${config.matrix.senderLocalpart}`,
    url: config.matrix.applicationServiceUrl,
    as_token: secrets.asToken,
    hs_token: secrets.hsToken,
    sender_localpart: config.matrix.senderLocalpart,
    namespaces: { users: [{ exclusive: true, regex: `^${escaped}$` }, { exclusive: true, regex: ghostNamespace }], aliases: [], rooms: [] },
    rate_limited: false,
    'de.sorunome.msc2409.push_ephemeral': false,
  }
}
