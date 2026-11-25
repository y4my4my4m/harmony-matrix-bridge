import { describe, expect, it } from 'vitest'
import { planLaunch } from './env.js'

const base = { HARMONY_URL: 'https://harmony.test/', HARMONY_SETUP_CODE: 'MX-AAAA-BBBB-CCCC', MATRIX_HOMESERVER_URL: 'https://matrix.test' }
const service = { ...base, MATRIX_SERVER_NAME: 'matrix.test', MATRIX_APPSERVICE_URL: 'http://bridge:9009' }
const account = { ...base, MATRIX_ACCESS_TOKEN: 'syt_0123456789' }

describe('planLaunch', () => {
  it('runs config.json as before when HARMONY_URL is unset', () => {
    expect(planLaunch({ HARMONY_TOKEN: 'x' }, './config.json')).toEqual({ kind: 'config', path: './config.json' })
  })
  it('prints instructions naming every variable when nothing is configured', () => {
    const plan = planLaunch({}, null)
    expect(plan.kind).toBe('error')
    const message = (plan as { message: string }).message
    for (const name of ['HARMONY_URL', 'HARMONY_SETUP_CODE', 'MATRIX_HOMESERVER_URL', 'MATRIX_SERVER_NAME', 'MATRIX_APPSERVICE_URL', 'MATRIX_ACCESS_TOKEN', 'config.json',
      'harmony-matrix-bridge-data:/data', 'ghcr.io/y4my4my4m/harmony-matrix-bridge:latest']) expect(message).toContain(name)
  })
  it('plans an application service, with tokens generated unless both are given', () => {
    expect(planLaunch(service, './config.json')).toMatchObject({ kind: 'managed', harmonyUrl: 'https://harmony.test', setupCode: 'MX-AAAA-BBBB-CCCC',
      ignoredConfig: './config.json', listen: { host: '0.0.0.0', port: 9009 },
      matrix: { kind: 'application_service', homeserverUrl: 'https://matrix.test', serverName: 'matrix.test', senderLocalpart: 'harmony_relay', applicationServiceUrl: 'http://bridge:9009', tokens: null } })
    const tokens = { MATRIX_AS_TOKEN: 'a'.repeat(64), MATRIX_HS_TOKEN: 'b'.repeat(64) }
    expect(planLaunch({ ...service, ...tokens, MATRIX_SENDER_LOCALPART: 'other' }, null)).toMatchObject({ matrix: { senderLocalpart: 'other', tokens: { asToken: 'a'.repeat(64), hsToken: 'b'.repeat(64) } } })
    for (const bad of [{ MATRIX_AS_TOKEN: 'a'.repeat(64) }, { MATRIX_AS_TOKEN: 'a'.repeat(64), MATRIX_HS_TOKEN: 'a'.repeat(64) }, { MATRIX_AS_TOKEN: 'short', MATRIX_HS_TOKEN: 'b'.repeat(64) }]) {
      const plan = planLaunch({ ...service, ...bad }, null)
      expect(plan.kind).toBe('error')
      expect((plan as { message: string }).message).not.toContain('aaaa')
    }
  })
  it('plans an ordinary account that listens for itself only', () => {
    expect(planLaunch(account, null)).toMatchObject({ kind: 'managed', listen: { host: '127.0.0.1', port: 9009 },
      matrix: { kind: 'account', homeserverUrl: 'https://matrix.test', accessToken: 'syt_0123456789' } })
    expect(planLaunch({ ...account, LISTEN_HOST: '0.0.0.0', LISTEN_PORT: '9100', DATA_DIR: '/data' }, null)).toMatchObject({ listen: { host: '0.0.0.0', port: 9100 }, dataDir: '/data' })
    expect(planLaunch({ ...account, MATRIX_AS_TOKEN: 'a'.repeat(64) }, null).kind).toBe('error')
  })
  it.each([[{ HARMONY_SETUP_CODE: 'MX-1' }, 'HARMONY_URL'], [{ HARMONY_URL: 'ftp://x' }, 'http'], [{ HARMONY_URL: 'https://user:SECRET@x' }, 'credentials'],
    [base, 'MATRIX_SERVER_NAME'], [{ ...service, MATRIX_HOMESERVER_URL: '' }, 'MATRIX_HOMESERVER_URL'], [{ ...service, MATRIX_SERVER_NAME: 'bad name' }, 'MATRIX_SERVER_NAME'],
    [{ ...service, MATRIX_APPSERVICE_URL: 'bridge:9009' }, 'MATRIX_APPSERVICE_URL'], [{ ...service, MATRIX_HOMESERVER_URL: 'matrix.example.org' }, 'MATRIX_HOMESERVER_URL'], [{ ...service, MATRIX_SENDER_LOCALPART: 'Bad Name' }, 'MATRIX_SENDER_LOCALPART'],
    [{ ...service, MATRIX_SERVER_NAME: 'a'.repeat(250) }, 'too long'], [{ ...service, LISTEN_PORT: 'ninety' }, 'LISTEN_PORT'], [{ ...account, MATRIX_ACCESS_TOKEN: 'two words here' }, 'MATRIX_ACCESS_TOKEN']])('explains %j', (env, words) => {
    const plan = planLaunch(env as NodeJS.ProcessEnv, null)
    expect(plan.kind).toBe('error')
    expect((plan as { message: string }).message).toContain(words)
    expect((plan as { message: string }).message).not.toContain('SECRET')
  })

  const host = { BRIDGE_MODE: 'host', HARMONY_URL: 'http://bot-gateway:3002', BRIDGE_HOST_SECRET: 's'.repeat(32) }
  it('plans an instance\'s host, whatever else is set', () => {
    expect(planLaunch({ ...host, DATA_DIR: '/data' }, './config.json')).toEqual({ kind: 'host', harmonyUrl: 'http://bot-gateway:3002', publicUrl: null, secret: 's'.repeat(32), dataDir: '/data',
      listen: { host: '0.0.0.0', port: 9009 }, anyAddress: false })
    expect(planLaunch({ ...account, ...host, BRIDGE_MODE: ' Host ', HARMONY_PUBLIC_URL: 'https://harmony.test/', LISTEN_HOST: '127.0.0.1', LISTEN_PORT: '9100', MATRIX_ALLOW_PRIVATE_HOMESERVERS: 'TRUE' }, null))
      .toMatchObject({ kind: 'host', publicUrl: 'https://harmony.test', listen: { host: '127.0.0.1', port: 9100 }, anyAddress: true })
    for (const value of ['', 'false', '0', 'no']) expect(planLaunch({ ...host, MATRIX_ALLOW_PRIVATE_HOMESERVERS: value }, null)).toMatchObject({ anyAddress: false })
  })
  it.each([[{ BRIDGE_MODE: 'hosted' }, 'BRIDGE_MODE'], [{ BRIDGE_MODE: 'host' }, 'HARMONY_URL and BRIDGE_HOST_SECRET'], [{ ...host, BRIDGE_HOST_SECRET: 'SECRET' }, '32'], [{ ...host, HARMONY_URL: 'ftp://x' }, 'http'],
    [{ ...host, HARMONY_PUBLIC_URL: 'har.mony.lol' }, 'HARMONY_PUBLIC_URL'], [{ ...host, MATRIX_ALLOW_PRIVATE_HOMESERVERS: 'maybe' }, 'true or false'], [{ ...host, LISTEN_PORT: '70000' }, 'LISTEN_PORT']])('explains %j', (env, words) => {
    const plan = planLaunch(env as NodeJS.ProcessEnv, null)
    expect(plan.kind).toBe('error')
    expect((plan as { message: string }).message).toContain(words)
    expect((plan as { message: string }).message).not.toContain('SECRET=')
  })
})
