import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CredentialsError, hashSetupCode, loadCredentials, obtainCredentials, serviceTokens, writeRegistration } from './credentials.js'
import type { ApplicationServicePlan } from './env.js'

let dataDir: string
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'matrix-credentials-')) })
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }) })
const answer = { bridge_id: 'b1', server_id: 's1', harmony_token: `harmony_bot_${'a'.repeat(64)}`, base_url: 'https://harmony.test',
  api_url: 'https://harmony.test/bot-gateway', gateway_url: 'wss://harmony.test/bot-gateway/gateway' }
const options = (fetchImpl: typeof fetch, setupCode: string | null = 'MX-AAAA-BBBB-CCCC', extra: { warn?: (line: string) => void } = {}) =>
  ({ harmonyUrl: 'https://harmony.test', setupCode, dataDir, apiBase: 'https://harmony.test/bot-gateway', fetchImpl, ...extra })
const plan: ApplicationServicePlan = { kind: 'application_service', homeserverUrl: 'https://matrix.test', serverName: 'matrix.test', senderLocalpart: 'harmony_relay',
  applicationServiceUrl: 'http://bridge:9009', tokens: null }

describe('setup code', () => {
  it('is redeemed once and its answer kept privately, without the code', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(answer))
    const first = await obtainCredentials(options(fetchImpl))
    expect(first.source).toBe('redeemed')
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://harmony.test/bot-gateway/bridge/v2/matrix/redeem')
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toEqual({ code: 'MX-AAAA-BBBB-CCCC' })
    const path = join(dataDir, 'credentials.json')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const text = readFileSync(path, 'utf8')
    expect(text).not.toContain('MX-AAAA')
    expect(JSON.parse(text)).toMatchObject({ ...answer, setup_code_sha256: hashSetupCode('mx-aaaa-bbbb-cccc ') })
    expect(readdirSync(dataDir)).toEqual(['credentials.json'])
    for (const code of ['MX-AAAA-BBBB-CCCC', ' mx-aaaa-bbbb-cccc', null]) {
      expect((await obtainCredentials(options(fetchImpl, code))).source).toBe('saved')
    }
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
  it('replaces the credentials for a new code and keeps them when it is refused', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(answer))
    await obtainCredentials(options(fetchImpl))
    fetchImpl.mockImplementationOnce(async () => Response.json({ ...answer, bridge_id: 'b2' }))
    expect((await obtainCredentials(options(fetchImpl, 'MX-DDDD-EEEE-FFFF'))).credentials.bridge_id).toBe('b2')
    const warn = vi.fn()
    fetchImpl.mockImplementationOnce(async () => Response.json({ code: 'invalid_code' }, { status: 400 }))
    const kept = await obtainCredentials(options(fetchImpl, 'MX-GGGG-HHHH-IIII', { warn }))
    expect(kept.credentials.bridge_id).toBe('b2')
    expect(warn).toHaveBeenCalledOnce()
    expect(loadCredentials(dataDir)!.bridge_id).toBe('b2')
  })
  it.each([[400, 'code_rejected'], [404, 'unsupported'], [429, 'unreachable'], [503, 'unreachable']])('reads HTTP %s as %s', async (status, kind) => {
    const error = await obtainCredentials(options(vi.fn<typeof fetch>(async () => Response.json({}, { status })))).catch(error => error)
    expect(error).toBeInstanceOf(CredentialsError)
    expect(error.kind).toBe(kind)
    expect(error.message).not.toContain('MX-')
  })
  it('asks for a code when there is neither one nor credentials, and refuses an answer without a token', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ...answer, harmony_token: '' }))
    await expect(obtainCredentials(options(fetchImpl, null))).rejects.toMatchObject({ kind: 'no_code' })
    expect(fetchImpl).not.toHaveBeenCalled()
    await expect(obtainCredentials(options(fetchImpl))).rejects.toMatchObject({ kind: 'unreachable' })
    expect(loadCredentials(dataDir)).toBeNull()
  })
  it('does not spend the code when the answer could not be kept', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(answer))
    const file = join(dataDir, 'occupied')
    writeFileSync(file, '')
    await expect(obtainCredentials({ ...options(fetchImpl), dataDir: join(file, 'data') })).rejects.toMatchObject({ kind: 'storage' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('application-service tokens', () => {
  it('are generated once, kept privately and written into the registration', () => {
    const tokens = serviceTokens(plan, dataDir)
    expect(tokens.asToken).toMatch(/^[a-f0-9]{64}$/)
    expect(tokens.hsToken).not.toBe(tokens.asToken)
    expect(serviceTokens(plan, dataDir)).toEqual(tokens)
    expect(writeRegistration(plan, tokens, dataDir)).toBe(true)
    expect(writeRegistration(plan, tokens, dataDir)).toBe(false)
    for (const name of ['appservice.json', 'registration.json']) expect(statSync(join(dataDir, name)).mode & 0o777).toBe(0o600)
    const registration = JSON.parse(readFileSync(join(dataDir, 'registration.json'), 'utf8'))
    expect(registration).toMatchObject({ id: 'harmony-matrix-relay', url: 'http://bridge:9009', as_token: tokens.asToken, hs_token: tokens.hsToken, sender_localpart: 'harmony_relay' })
    expect(writeRegistration({ ...plan, applicationServiceUrl: 'http://elsewhere:9009' }, tokens, dataDir)).toBe(true)
    expect(JSON.parse(readFileSync(join(dataDir, 'registration.json'), 'utf8'))).toMatchObject({ url: 'http://elsewhere:9009', as_token: tokens.asToken })
  })
  it('come from the environment when given, and a second bridge on a homeserver registers under its own name', () => {
    const given = { asToken: 'a'.repeat(64), hsToken: 'b'.repeat(64) }
    expect(serviceTokens({ ...plan, tokens: given }, dataDir)).toBe(given)
    writeRegistration({ ...plan, senderLocalpart: 'second' }, given, dataDir)
    expect(JSON.parse(readFileSync(join(dataDir, 'registration.json'), 'utf8')).id).toBe('harmony-matrix-relay-second')
    expect(readdirSync(dataDir)).toEqual(['registration.json'])
  })
  it('are not replaced when the stored ones are damaged', () => {
    for (const damage of ['{', '{"as_token":"x","hs_token":"y"}']) {
      writeFileSync(join(dataDir, 'appservice.json'), damage)
      expect(() => serviceTokens(plan, dataDir)).toThrow(CredentialsError)
    }
  })
})
