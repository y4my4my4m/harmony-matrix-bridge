import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { checkServiceTokens, DEFAULT_LOCALPART, httpUrl, localpartSchema, serverNameSchema } from './config.js'
import { normalizeHarmonyUrl } from './endpoints.js'

export const README_URL = 'https://github.com/y4my4my4m/harmony-matrix-bridge#readme'
export const DEFAULT_PORT = 9009

export interface ApplicationServicePlan {
  kind: 'application_service'
  homeserverUrl: string
  serverName: string
  senderLocalpart: string
  applicationServiceUrl: string
  /** Null: generated into the data directory. */
  tokens: { asToken: string; hsToken: string } | null
}
export interface AccountPlan { kind: 'account'; homeserverUrl: string; accessToken: string }
export type MatrixPlan = ApplicationServicePlan | AccountPlan

export interface ManagedPlan {
  kind: 'managed'
  harmonyUrl: string
  setupCode: string | null
  matrix: MatrixPlan
  dataDir: string
  /** Null: none, for a bridge run by a host. */
  listen: { host: string; port: number } | null
  /** A config.json that HARMONY_URL overrides. */
  ignoredConfig: string | null
}
/** BRIDGE_MODE=host: the bridges an instance runs. */
export interface HostPlan {
  kind: 'host'
  harmonyUrl: string
  /** For what people are told. */
  publicUrl: string | null
  secret: string
  dataDir: string
  listen: { host: string; port: number }
  /** Communities' homeservers on private addresses too. */
  anyAddress: boolean
}
export type LaunchPlan = { kind: 'config'; path: string } | ManagedPlan | HostPlan | { kind: 'error'; message: string }

// bot-gateway takes no shorter one.
const MIN_HOST_SECRET = 32

const NOT_CONFIGURED = [
  'Harmony Matrix bridge is not configured.',
  '',
  'Set these environment variables:',
  '  HARMONY_URL             your Harmony address, e.g. https://har.mony.lol',
  '  HARMONY_SETUP_CODE      the setup code from Harmony: Server settings, Bridges, Matrix (first run only)',
  '  MATRIX_HOMESERVER_URL   the homeserver\'s client address, e.g. https://matrix.example.org',
  '',
  'and, for an application service on your own homeserver:',
  '  MATRIX_SERVER_NAME      the name in its user IDs, e.g. example.org',
  '  MATRIX_APPSERVICE_URL   this bridge as the homeserver reaches it, e.g. http://harmony-matrix-bridge:9009',
  'or, for an ordinary Matrix account:',
  '  MATRIX_ACCESS_TOKEN     the account\'s access token',
  '',
  'Example:',
  '  docker run -d --name harmony-matrix-bridge --restart unless-stopped -p 9009:9009 \\',
  '    -v harmony-matrix-bridge-data:/data -e HARMONY_URL=https://har.mony.lol -e HARMONY_SETUP_CODE=MX-XXXX-XXXX-XXXX \\',
  '    -e MATRIX_HOMESERVER_URL=https://matrix.example.org -e MATRIX_SERVER_NAME=example.org \\',
  '    -e MATRIX_APPSERVICE_URL=http://bridge-host:9009 ghcr.io/y4my4my4m/harmony-matrix-bridge:latest',
  '',
  'A config.json in the working directory works too.',
  `Step-by-step guide: ${README_URL}`,
].join('\n')

function value(env: NodeJS.ProcessEnv, key: string): string | null {
  return env[key]?.trim() || null
}

function valid(schema: z.ZodType, input: string): boolean {
  return schema.safeParse(input).success
}

/** MATRIX_BRIDGE_CONFIG, else ./config.json when present. */
export function findConfigPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = value(env, 'MATRIX_BRIDGE_CONFIG')
  if (explicit) return explicit
  return existsSync('./config.json') ? './config.json' : null
}

function planMatrix(env: NodeJS.ProcessEnv): MatrixPlan | string {
  const homeserver = value(env, 'MATRIX_HOMESERVER_URL')
  const accessToken = value(env, 'MATRIX_ACCESS_TOKEN')
  const asToken = value(env, 'MATRIX_AS_TOKEN')
  const hsToken = value(env, 'MATRIX_HS_TOKEN')
  const serverName = value(env, 'MATRIX_SERVER_NAME')
  const serviceUrl = value(env, 'MATRIX_APPSERVICE_URL')
  if (accessToken && (asToken || hsToken)) {
    return 'MATRIX_ACCESS_TOKEN runs the bridge as an ordinary account; MATRIX_AS_TOKEN and MATRIX_HS_TOKEN as an application service. Set one or the other.'
  }
  const missing = [!homeserver && 'MATRIX_HOMESERVER_URL',
    !accessToken && !serverName && 'MATRIX_SERVER_NAME', !accessToken && !serviceUrl && 'MATRIX_APPSERVICE_URL'].filter(Boolean)
  if (missing.length) {
    const account = accessToken ? '' : ' With an ordinary Matrix account, set MATRIX_ACCESS_TOKEN in place of MATRIX_SERVER_NAME and MATRIX_APPSERVICE_URL.'
    return `${missing.join(' and ')} not set.${account}`
  }
  if (!valid(httpUrl, homeserver!)) return 'MATRIX_HOMESERVER_URL must be an http(s) address without credentials, query or fragment.'
  if (accessToken) {
    if (!/^[\x21-\x7e]{8,4096}$/.test(accessToken)) return 'MATRIX_ACCESS_TOKEN is not an access token.'
    return { kind: 'account', homeserverUrl: homeserver!, accessToken }
  }
  const senderLocalpart = value(env, 'MATRIX_SENDER_LOCALPART') ?? DEFAULT_LOCALPART
  if (!valid(serverNameSchema, serverName!)) return 'MATRIX_SERVER_NAME must be the server name of your user IDs, e.g. example.org.'
  if (!valid(httpUrl, serviceUrl!)) return 'MATRIX_APPSERVICE_URL must be an http(s) address without credentials, query or fragment.'
  if (!valid(localpartSchema, senderLocalpart)) return 'MATRIX_SENDER_LOCALPART may hold a-z, 0-9 and . _ = - only.'
  // Matrix user IDs hold at most 255 characters; a ghost's is the sender's and 35 more.
  if (`@${senderLocalpart}:${serverName}`.length + 35 > 255) return 'MATRIX_SENDER_LOCALPART and MATRIX_SERVER_NAME are too long together.'
  if (!asToken !== !hsToken) return 'Set MATRIX_AS_TOKEN and MATRIX_HS_TOKEN together, or neither: without them both are generated.'
  if (asToken && hsToken) {
    try { checkServiceTokens(asToken, hsToken) }
    catch (error) { return (error as Error).message }
  }
  return { kind: 'application_service', homeserverUrl: homeserver!, serverName: serverName!, senderLocalpart,
    applicationServiceUrl: serviceUrl!, tokens: asToken && hsToken ? { asToken, hsToken } : null }
}

function planListen(env: NodeJS.ProcessEnv, host: string): { host: string; port: number } | string {
  const rawPort = value(env, 'LISTEN_PORT')
  const port = rawPort === null ? DEFAULT_PORT : Number(rawPort)
  if (!Number.isInteger(port) || port < 0 || port > 65535) return `LISTEN_PORT="${rawPort}" is not a port number.`
  return { host: value(env, 'LISTEN_HOST') ?? host, port }
}

function planDataDir(env: NodeJS.ProcessEnv): string {
  const dataDir = value(env, 'DATA_DIR') ?? './data'
  return isAbsolute(dataDir) ? dataDir : resolve(dataDir)
}

function planHost(env: NodeJS.ProcessEnv): HostPlan | string {
  const rawUrl = value(env, 'HARMONY_URL')
  const secret = value(env, 'BRIDGE_HOST_SECRET')
  const missing = [!rawUrl && 'HARMONY_URL', !secret && 'BRIDGE_HOST_SECRET'].filter(Boolean)
  if (missing.length) return `BRIDGE_MODE=host needs HARMONY_URL and BRIDGE_HOST_SECRET; ${missing.join(' and ')} not set.`
  if (secret!.length < MIN_HOST_SECRET) return `BRIDGE_HOST_SECRET must have at least ${MIN_HOST_SECRET} characters, as MATRIX_BRIDGE_HOST_SECRET of the bot gateway.`
  let harmonyUrl: string
  try { harmonyUrl = normalizeHarmonyUrl(rawUrl!) }
  catch (error) { return (error as Error).message }
  const publicUrl = value(env, 'HARMONY_PUBLIC_URL')
  if (publicUrl && !valid(httpUrl, publicUrl)) return 'HARMONY_PUBLIC_URL must be an http(s) address without credentials, query or fragment.'
  const rawAny = (value(env, 'MATRIX_ALLOW_PRIVATE_HOMESERVERS') ?? 'false').toLowerCase()
  if (!['true', '1', 'yes', 'false', '0', 'no'].includes(rawAny)) return 'MATRIX_ALLOW_PRIVATE_HOMESERVERS must be true or false.'
  const listen = planListen(env, '0.0.0.0')
  if (typeof listen === 'string') return listen
  return { kind: 'host', harmonyUrl, publicUrl: publicUrl?.replace(/\/+$/, '') ?? null, secret: secret!, dataDir: planDataDir(env), listen,
    anyAddress: ['true', '1', 'yes'].includes(rawAny) }
}

/** BRIDGE_MODE=host, else HARMONY_URL: managed by the Harmony server it names. Otherwise config.json, and without one the instructions. */
export function planLaunch(env: NodeJS.ProcessEnv, configPath: string | null): LaunchPlan {
  const mode = value(env, 'BRIDGE_MODE')
  if (mode !== null) {
    const plan = mode.toLowerCase() === 'host' ? planHost(env) : `BRIDGE_MODE="${mode}" is not known. Leave it out, or set it to host to run an instance's bridges.`
    return typeof plan === 'string' ? { kind: 'error', message: plan } : plan
  }
  const rawUrl = value(env, 'HARMONY_URL')
  const setupCode = value(env, 'HARMONY_SETUP_CODE')
  if (!rawUrl) {
    if (setupCode) return { kind: 'error', message: 'HARMONY_SETUP_CODE needs HARMONY_URL, the address of your Harmony.' }
    return configPath ? { kind: 'config', path: configPath } : { kind: 'error', message: NOT_CONFIGURED }
  }
  let harmonyUrl: string
  try { harmonyUrl = normalizeHarmonyUrl(rawUrl) }
  catch (error) { return { kind: 'error', message: (error as Error).message } }
  const matrix = planMatrix(env)
  if (typeof matrix === 'string') return { kind: 'error', message: matrix }
  // The homeserver calls an application service; an account's listener answers /health alone.
  const listen = planListen(env, matrix.kind === 'account' ? '127.0.0.1' : '0.0.0.0')
  if (typeof listen === 'string') return { kind: 'error', message: listen }
  return { kind: 'managed', harmonyUrl, setupCode, matrix, dataDir: planDataDir(env), listen, ignoredConfig: configPath }
}
