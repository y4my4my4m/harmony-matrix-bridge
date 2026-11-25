import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { discoverHomeserver, isSafeForSecrets } from './homeserver.js'
import { endpoint, HttpError, requestJson, type FetchImpl } from './http.js'

/** Printed as it is; holds no password and no token. */
export class LoginError extends Error {}

const DEVICE_NAME = 'Harmony bridge'

export type Ask = (question: string, hidden: boolean) => Promise<string>

export interface Terminal { input: NodeJS.ReadStream; output: NodeJS.WritableStream }

/** Questions go to `output`; a hidden answer is shown nowhere and kept in no history. */
export function askOnTerminal({ input, output }: Terminal): Ask {
  if (!input.isTTY) throw new LoginError('--login asks for the password on a terminal. With Docker, run it with -it.')
  return (question, hidden) => new Promise((resolve, reject) => {
    output.write(question)
    const echo = new Writable({ write(chunk, _encoding, done) { if (!hidden) output.write(chunk); done() } })
    const line = createInterface({ input, output: echo, terminal: true, historySize: 0 })
    let answered = false
    line.once('line', answer => {
      answered = true
      line.close()
      if (hidden) output.write('\n')
      resolve(answer)
    })
    line.once('SIGINT', () => line.close())
    line.once('close', () => { if (!answered) { output.write('\n'); reject(new LoginError('Cancelled.')) } })
  })
}

function words(error: unknown, address: string): LoginError {
  if (error instanceof LoginError) return error
  if (!(error instanceof HttpError)) return new LoginError('The sign-in failed.')
  if (error.status === 429) {
    const wait = error.retryAfterMs === undefined ? 'a few minutes' : `${Math.max(1, Math.ceil(error.retryAfterMs / 1000))} seconds`
    return new LoginError(`Too many tries. Wait ${wait}, then run --login again.`)
  }
  if (error.status === undefined || error.status >= 500) return new LoginError(`Cannot reach the homeserver at ${address}.`)
  return new LoginError(`The homeserver at ${address} refused (HTTP ${error.status}).`)
}

export interface LoginOptions {
  /** MATRIX_HOMESERVER_URL. */
  address: string | null
  ask: () => Ask
  /** Everything but the token. */
  say: (line: string) => void
  fetchImpl?: FetchImpl
}

/** An access token that lasts: signed in by password, without a refresh token. */
export async function login(options: LoginOptions): Promise<string> {
  const { fetchImpl, say } = options
  if (!options.address) throw new LoginError('Set MATRIX_HOMESERVER_URL to your homeserver\'s address, e.g. https://matrix.org.')
  if (!isSafeForSecrets(options.address)) throw new LoginError('MATRIX_HOMESERVER_URL must start with https://, or be http:// on a loopback or private address.')
  // Before anything is asked of the network or the person.
  const ask = options.ask()
  let base: string
  let flows: unknown
  try {
    base = await discoverHomeserver(options.address, fetchImpl)
    if (!isSafeForSecrets(base)) throw new LoginError(`${options.address} names a homeserver without https.`)
  } catch (error) { throw words(error, options.address) }
  try { flows = (await requestJson<{ flows?: unknown }>(endpoint(base, '_matrix/client/v3/login'), { method: 'GET' }, fetchImpl))?.flows }
  catch (error) {
    if (error instanceof HttpError && error.status !== undefined && error.status < 500 && error.status !== 429) throw new LoginError(`No Matrix homeserver answers at ${base}.`)
    throw words(error, base)
  }
  if (!Array.isArray(flows) || !flows.some(flow => flow?.type === 'm.login.password')) {
    throw new LoginError('This homeserver offers no sign-in by password. Use an account on one that does.')
  }
  say(`Signing in at ${base}`)
  const user = (await ask('Matrix user name: ', false)).trim()
  if (!user) throw new LoginError('No user name given.')
  const password = await ask('Password (not shown): ', true)
  if (!password) throw new LoginError('No password given.')
  let answer: { access_token?: unknown; user_id?: unknown; expires_in_ms?: unknown; refresh_token?: unknown } | undefined
  try {
    answer = await requestJson(endpoint(base, '_matrix/client/v3/login'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user }, password, initial_device_display_name: DEVICE_NAME }),
    }, fetchImpl, 60_000)
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) throw new LoginError('Wrong user name or password.')
    throw words(error, base)
  }
  const token = answer?.access_token
  if (typeof token !== 'string' || !/^[\x21-\x7e]{8,4096}$/.test(token)) throw new LoginError('The homeserver answered without an access token.')
  if ((answer!.expires_in_ms !== undefined && answer!.expires_in_ms !== null) || answer!.refresh_token) {
    // A session nobody can use is not left behind.
    await requestJson(endpoint(base, '_matrix/client/v3/logout'), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' }, fetchImpl).catch(() => {})
    throw new LoginError('The tokens of this homeserver expire, so the bridge cannot use one. Use an account on another homeserver, or an application service.')
  }
  say(`Signed in${typeof answer!.user_id === 'string' ? ` as ${answer!.user_id}` : ''}, in a session named "${DEVICE_NAME}". Signing that session out ends the token.`)
  say('Set the next line as MATRIX_ACCESS_TOKEN:')
  return token
}
