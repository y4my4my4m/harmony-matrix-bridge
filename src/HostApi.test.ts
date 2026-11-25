import { describe, expect, it, vi } from 'vitest'
import { HostApi } from './HostApi.js'
import { HttpError } from './http.js'

const id = (index: number) => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`
const secret = 's'.repeat(32)
const service = { connection: 'application_service', homeserver_url: 'http://synapse:8008', server_name: 'example.org', sender_localpart: 'harmony_relay', as_token: 'a'.repeat(64), hs_token: 'b'.repeat(64),
  access_token: null, bridges: [{ bridge_id: id(3), harmony_token: 'harmony_bot_c' }] }
const account = { ...service, connection: 'account', homeserver_url: 'https://example.org', as_token: null, hs_token: null, server_name: null, sender_localpart: null, access_token: 'syt_secret', bridges: [] }
const hosted = { bridge_id: id(1), harmony_token: 'harmony_bot_a', homeserver_url: 'https://example.org', access_token: 'syt_community' }

function setup(...answers: Array<[number, unknown]>) {
  const fetchImpl = vi.fn<typeof fetch>()
  for (const [status, body] of answers) fetchImpl.mockResolvedValueOnce(Response.json(body, { status }))
  return { fetchImpl, api: new HostApi('http://gateway:3002', secret, fetchImpl) }
}

describe('HostApi', () => {
  it('reads what to run, with the host\'s secret', async () => {
    const { api, fetchImpl } = setup([200, { hosted: [hosted], instance: service }], [200, { hosted: [], instance: account }], [200, { hosted: [], instance: null }])
    expect(await api.list()).toEqual({ hosted: [hosted], instance: { access: { connection: 'application_service', homeserver_url: 'http://synapse:8008', server_name: 'example.org', sender_localpart: 'harmony_relay',
      as_token: 'a'.repeat(64), hs_token: 'b'.repeat(64) }, bridges: [{ bridge_id: id(3), harmony_token: 'harmony_bot_c' }] } })
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://gateway:3002/bridge/v2/matrix/host')
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { 'X-Bridge-Host-Secret': secret } })
    expect((await api.list()).instance).toEqual({ access: { connection: 'account', homeserver_url: 'https://example.org', access_token: 'syt_secret' }, bridges: [] })
    expect((await api.list()).instance).toBeNull()
  })
  it('leaves out an entry it cannot use, not the others', async () => {
    const other = { ...hosted, bridge_id: id(2) }
    const bad = [null, {}, { ...hosted, bridge_id: '../../etc' }, { ...other, homeserver_url: 'http://example.org' }, { ...other, homeserver_url: 'example.org' }, { ...other, homeserver_url: 'https://user:pw@example.org' }, { ...other, access_token: 'a b' }, { ...other, harmony_token: null }]
    const { api } = setup([200, { hosted: [...bad, hosted, hosted], instance: { ...service, bridges: [{ bridge_id: 'x', harmony_token: 'y' }, ...service.bridges] } }])
    const list = await api.list()
    expect(list.hosted).toEqual([hosted])
    expect(list.instance!.bridges).toEqual(service.bridges)
  })
  it.each([null, {}, [], { hosted: [] }, { hosted: null, instance: null }, { hosted: [], instance: { connection: 'other' } }, { hosted: [], instance: { ...service, hs_token: null } }, { hosted: [], instance: 'x' }])('refuses %j as a whole: what is left out would be stopped', async body => {
    const { api } = setup([200, body])
    await expect(api.list()).rejects.toMatchObject({ transient: true })
  })
  it('reports and links', async () => {
    const { api, fetchImpl } = setup([200, { ok: true }], [200, { bridge_id: id(3), server_name: 'My\nserver', channel_id: id(4), channel_name: 'general' }], [200, {}])
    const status = { version: '1.0.0', instance: { ready: true, user_id: '@harmony_relay:example.org', server_name: 'example.org', problems: [] }, hosted: 2 }
    await api.status(status)
    expect([String(fetchImpl.mock.calls[0][0]), JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)]).toEqual(['http://gateway:3002/bridge/v2/matrix/host/status', status])
    expect(await api.link('ML-AAAA-BBBB-CCCC', '!room:x', '@alice:x')).toEqual({ bridgeId: id(3), serverName: 'My server', channelName: 'general' })
    expect(JSON.parse(fetchImpl.mock.calls[1][1]!.body as string)).toEqual({ code: 'ML-AAAA-BBBB-CCCC', room_id: '!room:x', sender: '@alice:x' })
    await expect(api.link('ML', '!room:x', '@alice:x')).rejects.toBeInstanceOf(HttpError)
  })
  it.each([[400, 'invalid_code'], [409, 'channel_encrypted']])('passes on %i %s', async (status, code) => {
    const { api } = setup([status, { code, error: 'x' }])
    await expect(api.link('ML', '!room:x', '@alice:x')).rejects.toMatchObject({ status, errcode: code })
  })
})
