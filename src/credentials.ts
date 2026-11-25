import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { BridgeApi, type Redeemed } from './BridgeApi.js'
import { checkServiceTokens, registration } from './config.js'
import type { ApplicationServicePlan } from './env.js'
import { HttpError, type FetchImpl } from './http.js'

const credentialsSchema = z.object({
  version: z.literal(1),
  bridge_id: z.string(),
  server_id: z.string(),
  harmony_token: z.string().min(1),
  api_url: z.string().min(1),
  gateway_url: z.string().min(1),
  base_url: z.string(),
  /** HARMONY_URL at redeem time. */
  harmony_url: z.string(),
  /** A different code is redeemed anew. */
  setup_code_sha256: z.string(),
  redeemed_at: z.string(),
})
export type StoredCredentials = z.infer<typeof credentialsSchema>

export class CredentialsError extends Error {
  constructor(message: string, readonly kind: 'no_code' | 'code_rejected' | 'unsupported' | 'unreachable' | 'storage') { super(message) }
}

/** Codes compare without case and surrounding whitespace. */
export function hashSetupCode(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex')
}

/** Mode 0600, written beside and renamed over. */
function writePrivate(dataDir: string, name: string, content: unknown): void {
  const path = join(dataDir, name)
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const temporary = `${path}.tmp-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
  } catch {
    throw new CredentialsError(`Cannot write ${path}. DATA_DIR must be a writable directory; with Docker, mount a volume at /data.`, 'storage')
  }
}

function readPrivate(path: string): unknown {
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch { throw new CredentialsError(`${path} cannot be read. Restore it, or delete it and start again.`, 'storage') }
}

export function loadCredentials(dataDir: string): StoredCredentials | null {
  const parsed = credentialsSchema.safeParse(readPrivate(join(dataDir, 'credentials.json')))
  return parsed.success ? parsed.data : null
}

export function saveCredentials(dataDir: string, credentials: StoredCredentials): void {
  writePrivate(dataDir, 'credentials.json', credentials)
}

export interface ObtainOptions {
  harmonyUrl: string
  setupCode: string | null
  dataDir: string
  apiBase: string
  fetchImpl?: FetchImpl
  warn?: (line: string) => void
}

/**
 * Saved credentials, or one redeem of HARMONY_SETUP_CODE. A code already redeemed costs no request; a
 * different one replaces the credentials, and when it is refused the saved ones stay.
 */
export async function obtainCredentials(options: ObtainOptions): Promise<{ credentials: StoredCredentials; source: 'saved' | 'redeemed' }> {
  const saved = loadCredentials(options.dataDir)
  const code = options.setupCode?.trim() || null
  if (!code) {
    if (saved) return { credentials: saved, source: 'saved' }
    throw new CredentialsError('No setup code and no saved credentials. Set HARMONY_SETUP_CODE to the code from Harmony: Server settings, Bridges, Matrix.', 'no_code')
  }
  if (saved && saved.setup_code_sha256 === hashSetupCode(code)) return { credentials: saved, source: 'saved' }

  // A code works once: somewhere to keep its answer comes first.
  writePrivate(options.dataDir, 'write-check', null)
  rmSync(join(options.dataDir, 'write-check'), { force: true })
  let redeemed: Redeemed
  try { redeemed = await BridgeApi.redeem(options.apiBase, code, options.fetchImpl) }
  catch (error) {
    if (!(error instanceof HttpError) || error.transient || error.status === undefined) {
      throw new CredentialsError('Cannot redeem the setup code: Harmony does not answer', 'unreachable')
    }
    if (saved) {
      options.warn?.('HARMONY_SETUP_CODE was refused; keeping the saved credentials. Remove HARMONY_SETUP_CODE to silence this.')
      return { credentials: saved, source: 'saved' }
    }
    if (error.status === 404) throw new CredentialsError('This Harmony takes no Matrix setup codes. It needs Harmony 1.9.9 or later.', 'unsupported')
    throw new CredentialsError('Harmony refused the setup code. A code works once, for 30 minutes: make a new one in Harmony, Server settings, Bridges, Matrix.', 'code_rejected')
  }
  const credentials: StoredCredentials = { version: 1, ...redeemed, harmony_url: options.harmonyUrl,
    setup_code_sha256: hashSetupCode(code), redeemed_at: new Date().toISOString() }
  saveCredentials(options.dataDir, credentials)
  return { credentials, source: 'redeemed' }
}

export interface ServiceTokens { asToken: string; hsToken: string }

/** The application-service tokens: from the environment, else generated once and kept in DATA_DIR. */
export function serviceTokens(plan: ApplicationServicePlan, dataDir: string): ServiceTokens {
  if (plan.tokens) return plan.tokens
  const path = join(dataDir, 'appservice.json')
  const stored = readPrivate(path) as { as_token?: unknown; hs_token?: unknown } | null
  if (stored) {
    const tokens = { asToken: String(stored.as_token), hsToken: String(stored.hs_token) }
    try { checkServiceTokens(tokens.asToken, tokens.hsToken) }
    catch { throw new CredentialsError(`${path} holds no usable tokens. Restore it, or delete it, start again and register the bridge anew.`, 'storage') }
    return tokens
  }
  const tokens = { asToken: randomBytes(32).toString('hex'), hsToken: randomBytes(32).toString('hex') }
  writePrivate(dataDir, 'appservice.json', { as_token: tokens.asToken, hs_token: tokens.hsToken })
  return tokens
}

/** DATA_DIR/registration.json for the homeserver; JSON is YAML. True when its content changed. */
export function writeRegistration(plan: ApplicationServicePlan, tokens: ServiceTokens, dataDir: string): boolean {
  const content = registration({ matrix: plan }, tokens)
  let current: unknown
  try { current = readPrivate(join(dataDir, 'registration.json')) } catch { current = null }
  if (JSON.stringify(current) === JSON.stringify(content)) return false
  writePrivate(dataDir, 'registration.json', content)
  return true
}
