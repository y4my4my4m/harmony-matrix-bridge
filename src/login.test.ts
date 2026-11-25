import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { discoverHomeserver, isPrivateAddress, isSafeForSecrets } from './homeserver.js'
import { askOnTerminal, login, LoginError, type Ask } from './login.js'

const PASSWORD = 'pass"word\\ with § and spaces '
const TOKEN = 'syt_lasting_token_0123456789'
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers })

/** A homeserver at api.test behind https://example.org/.well-known. */
function homeserver(answers: Partial<Record<'wellKnown' | 'flows' | 'login' | 'logout', () => Response | Promise<Response>>> = {}) {
  const calls: Array<{ method: string; url: string; body?: any; auth?: string }> = []
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    const headers = init?.headers as Record<string, string> | undefined
    calls.push({ method: init?.method ?? 'GET', url, ...(init?.body ? { body: JSON.parse(init.body as string) } : {}), ...(headers?.Authorization ? { auth: headers.Authorization } : {}) })
    if (url.endsWith('/.well-known/matrix/client')) return answers.wellKnown?.() ?? json({ 'm.homeserver': { base_url: 'https://api.test/' } })
    if (url.endsWith('/logout')) return answers.logout?.() ?? json({})
    if (init?.method === 'POST') return answers.login?.() ?? json({ access_token: TOKEN, user_id: '@bridge:example.org', device_id: 'D' })
    return answers.flows?.() ?? json({ flows: [{ type: 'm.login.sso' }, { type: 'm.login.password' }] })
  })
  return { calls, fetchImpl }
}
function person(user = '@bridge:example.org', password = PASSWORD) {
  const questions: Array<[string, boolean]> = []
  const ask: Ask = async (question, hidden) => { questions.push([question, hidden]); return hidden ? password : user }
  return { questions, ask: () => ask }
}
async function run(server = homeserver(), who = person(), address: string | null = 'https://example.org') {
  const said: string[] = []
  const result = await login({ address, ask: who.ask, say: line => said.push(line), fetchImpl: server.fetchImpl }).catch(error => error)
  return { result, said: said.join('\n'), ...server, ...who }
}

describe('--login', () => {
  it('signs in by password, without a refresh token, at the homeserver the address names', async () => {
    const { result, said, calls, questions } = await run()
    expect(result).toBe(TOKEN)
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['GET https://example.org/.well-known/matrix/client', 'GET https://api.test/_matrix/client/v3/login', 'POST https://api.test/_matrix/client/v3/login'])
    expect(calls[2].body).toEqual({ type: 'm.login.password', identifier: { type: 'm.id.user', user: '@bridge:example.org' }, password: PASSWORD, initial_device_display_name: 'Harmony bridge' })
    expect(questions).toEqual([['Matrix user name: ', false], ['Password (not shown): ', true]])
    expect(said).toContain('@bridge:example.org')
    expect(said).not.toContain(PASSWORD)
    expect(said).not.toContain(TOKEN)
  })
  it.each([
    ['no address', null, {}, 'MATRIX_HOMESERVER_URL'],
    ['http on the internet', 'http://example.org', {}, 'https://'],
    ['a .well-known that gives up https', 'https://example.org', { wellKnown: () => json({ 'm.homeserver': { base_url: 'http://api.test' } }), flows: () => json({}, 404) }, 'No Matrix homeserver answers at https://example.org'],
    ['no password sign-in', 'https://example.org', { flows: () => json({ flows: [{ type: 'm.login.sso' }] }) }, 'no sign-in by password'],
    ['an odd answer', 'https://example.org', { flows: () => json({ flows: 'x' }) }, 'no sign-in by password'],
    ['a wrong password', 'https://example.org', { login: () => json({ errcode: 'M_FORBIDDEN', error: 'SECRET' }, 403) }, 'Wrong user name or password'],
    ['too many tries', 'https://example.org', { login: () => json({ errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 41_500 }, 429) }, 'Wait 42 seconds'],
    ['too many tries without a time', 'https://example.org', { flows: () => json({}, 429) }, 'Wait a few minutes'],
    ['a homeserver that is down', 'https://example.org', { flows: () => json({}, 502) }, 'Cannot reach the homeserver at https://api.test'],
    ['a network that is down', 'https://example.org', { login: () => { throw new Error('ECONNRESET SECRET') } }, 'Cannot reach the homeserver'],
    ['another refusal', 'https://example.org', { login: () => json({ error: 'SECRET' }, 400) }, 'HTTP 400'],
    ['no token', 'https://example.org', { login: () => json({ user_id: '@bridge:example.org' }) }, 'without an access token'],
  ] as const)('says in words: %s', async (_name, address, answers, expected) => {
    const { result, said, calls } = await run(homeserver(answers), person(), address)
    expect(result).toBeInstanceOf(LoginError)
    expect(result.message).toContain(expected)
    for (const text of [result.message, said]) for (const secret of ['SECRET', PASSWORD, TOKEN]) expect(text).not.toContain(secret)
    if (expected !== 'Wrong user name or password' && !calls.some(call => call.method === 'POST')) expect(JSON.stringify(calls)).not.toContain('pass')
  })
  it.each([{ expires_in_ms: 300_000 }, { refresh_token: 'syr_x' }, { expires_in_ms: 0 }])('gives no token that expires (%j), and ends its session', async extra => {
    const { result, said, calls } = await run(homeserver({ login: () => json({ access_token: TOKEN, ...extra }) }))
    expect(result).toBeInstanceOf(LoginError)
    expect(result.message).toContain('expire')
    expect(said + result.message).not.toContain(TOKEN)
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: 'https://api.test/_matrix/client/v3/logout', auth: `Bearer ${TOKEN}` })
  })
  it('asks for nothing before it knows that a password can be used, and takes no empty answer', async () => {
    const { questions, result } = await run(homeserver({ flows: () => json({ flows: [] }) }))
    expect(result).toBeInstanceOf(LoginError)
    expect(questions).toEqual([])
    for (const who of [person('  '), person('user', '')]) {
      const { result, calls } = await run(homeserver(), who)
      expect(result.message).toMatch(/^No (user name|password) given/)
      expect(calls.some(call => call.method === 'POST')).toBe(false)
    }
  })
  it('works at a private address without https', async () => {
    const { result, calls } = await run(homeserver({ wellKnown: () => json({}, 404) }), person(), 'http://192.168.1.10:8008')
    expect(result).toBe(TOKEN)
    expect(calls.at(-1)!.url).toBe('http://192.168.1.10:8008/_matrix/client/v3/login')
  })
})

describe('the terminal', () => {
  function terminal() {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() }) as unknown as NodeJS.ReadStream & { setRawMode: ReturnType<typeof vi.fn> }
    const output = new PassThrough()
    let shown = ''
    output.on('data', chunk => { shown += String(chunk) })
    return { input, output, shown: () => shown }
  }
  it('shows the user name and nothing of the password, edits included', async () => {
    const { input, output, shown } = terminal()
    const ask = askOnTerminal({ input, output })
    const user = ask('User: ', false)
    input.push('alice\r')
    expect(await user).toBe('alice')
    expect(shown()).toContain('alice')
    const password = ask('Password: ', true)
    expect(input.setRawMode).toHaveBeenLastCalledWith(true)
    input.push('wrongX\u007f')
    input.push('\u0015s3cret "p" ü\r')
    expect(await password).toBe('s3cret "p" ü')
    expect(input.setRawMode).toHaveBeenLastCalledWith(false)
    for (const part of ['wrong', 's3cret', 'ü']) expect(shown()).not.toContain(part)
  })
  it('refuses without a terminal and can be cancelled', async () => {
    const { input, output } = terminal()
    expect(() => askOnTerminal({ input: Object.assign(new PassThrough(), { isTTY: false }) as unknown as NodeJS.ReadStream, output })).toThrow(/-it/)
    const asked = askOnTerminal({ input, output })('Password: ', true)
    input.push('abc\u0003')
    await expect(asked).rejects.toThrow('Cancelled')
  })
  it('is what the command runs on, and without one it leaves stdout empty', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', '--login'], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH!, MATRIX_HOMESERVER_URL: 'https://example.org' } })
    let out = ''
    let err = ''
    child.stdout!.on('data', chunk => { out += String(chunk) })
    child.stderr!.on('data', chunk => { err += String(chunk) })
    child.stdin!.end('user\npassword\n')
    expect((await once(child, 'exit'))[0]).toBe(1)
    expect(out).toBe('')
    expect(err).toContain('terminal')
  }, 15_000)
})

describe('the homeserver behind an address', () => {
  const answering = (body: unknown, status = 200) => vi.fn<typeof fetch>(async () => json(body, status))
  it.each([
    ['https://matrix.org', { 'm.homeserver': { base_url: 'https://matrix-client.matrix.org/' } }, 200, 'https://matrix-client.matrix.org'],
    ['https://example.org/', {}, 200, 'https://example.org'],
    ['https://example.org', { 'm.homeserver': { base_url: 'https://user:pass@evil.test' } }, 200, 'https://example.org'],
    ['https://example.org', { 'm.homeserver': { base_url: 'ftp://evil.test' } }, 200, 'https://example.org'],
    ['https://example.org', { 'm.homeserver': { base_url: 'http://example.org' } }, 200, 'https://example.org'],
    ['http://localhost:8008', { 'm.homeserver': { base_url: 'http://localhost:8009' } }, 200, 'http://localhost:8009'],
    ['http://localhost:8008', { 'm.homeserver': { base_url: 'http://elsewhere.test' } }, 200, 'http://localhost:8008'],
    ['https://example.org', { errcode: 'M_NOT_FOUND' }, 404, 'https://example.org'],
    ['https://example.org', {}, 502, 'https://example.org'],
  ])('%s with %j (%s) is %s', async (address, body, status, expected) => {
    const fetchImpl = answering(body, status)
    await expect(discoverHomeserver(address, fetchImpl)).resolves.toBe(expected)
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'error' })
  })
  it('is the address when nothing answers', async () => {
    await expect(discoverHomeserver('https://example.org', vi.fn<typeof fetch>().mockRejectedValue(new Error('down')))).resolves.toBe('https://example.org')
  })
  it('knows private addresses', () => {
    for (const yes of ['http://localhost:8008', 'http://127.0.0.1', 'http://10.1.2.3', 'http://172.16.0.1', 'http://172.31.9.9', 'http://192.168.0.4', 'http://169.254.1.1', 'http://[::1]:8008', 'http://[fd00::1]', 'http://[fe80::1]', 'http://hs.localhost']) {
      expect(isPrivateAddress(yes), yes).toBe(true)
      expect(isSafeForSecrets(yes), yes).toBe(true)
    }
    for (const no of ['http://example.org', 'http://172.32.0.1', 'http://11.0.0.1', 'http://127.0.0.1.evil.test', 'http://10.evil.test', 'http://fd00.example.org', 'http://[2001:db8::1]', 'http://[::ffff:8.8.8.8]', 'not a url']) {
      expect(isPrivateAddress(no), no).toBe(false)
      expect(isSafeForSecrets(no), no).toBe(false)
    }
    expect(isSafeForSecrets('https://example.org')).toBe(true)
    expect(isSafeForSecrets('ftp://127.0.0.1')).toBe(false)
  })
})
