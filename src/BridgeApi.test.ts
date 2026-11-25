import { describe, expect, it, vi } from 'vitest'
import { BridgeApi, type StatusReport } from './BridgeApi.js'

const channel = '22222222-2222-4222-8222-222222222222'
function setup(body: unknown = {}, status = 200, base = 'https://harmony.test/bot-gateway') {
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(body, { status }))
  return { fetchImpl, api: new BridgeApi(base, 'SECRET', fetchImpl) }
}
const config = (pairs: unknown[]) => ({ bridge_id: 'b', server_id: 's', mode: 'self', updated_at: '2026-11-25T00:00:00Z', privacy_version: '1:2', base_url: 'https://harmony.test', pairs })

describe('BridgeApi', () => {
  it('reads the configuration with the bot token', async () => {
    const { api, fetchImpl } = setup(config([
      { channel_id: channel, channel_name: 'general', room_id: null, room_alias: '#general:matrix.test', direction: 'both', sender_mode: 'ghost', encrypted: false },
      { channel_id: channel.replace('2222', '3333'), channel_name: 'news', room_id: '!opaque', room_alias: null, direction: 'to_matrix', sender_mode: 'relay', encrypted: true }]))
    await expect(api.config()).resolves.toEqual({ bridgeId: 'b', serverId: 's', updatedAt: '2026-11-25T00:00:00Z', privacyVersion: '1:2', pairs: [
      { channelId: channel, channelName: 'general', roomId: null, roomAlias: '#general:matrix.test', direction: 'both', senderMode: 'ghost', encrypted: false },
      { channelId: channel.replace('2222', '3333'), channelName: 'news', roomId: '!opaque', roomAlias: null, direction: 'to_matrix', senderMode: 'relay', encrypted: true }] })
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://harmony.test/bot-gateway/bridge/v2/matrix/config')
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { Authorization: 'Bot SECRET' }, redirect: 'error' })
  })
  it('leaves out pairs it cannot use and takes no malformed configuration', async () => {
    const good = { channel_id: channel, room_id: '!a:test', direction: 'both', sender_mode: 'relay' }
    const { api } = setup(config([good, { ...good, room_id: '!again:test' }, { ...good, channel_id: 'x' }, { ...good, direction: 'sideways' }, { ...good, channel_id: channel.replace('2222', '4444'), room_id: null, room_alias: 'no alias' }, null]))
    expect((await api.config()).pairs.map(pair => pair.roomId)).toEqual(['!a:test'])
    for (const body of [[], {}, { ...config([]), pairs: null }, 'text']) await expect(setup(body).api.config()).rejects.toMatchObject({ transient: true })
  })
  it('names the channel for a bot no managed bridge owns, below either form of the gateway address', async () => {
    const { api, fetchImpl } = setup({ opted_out: true, since: null, source: 'user' }, 200, 'https://harmony.test/bot-gateway/api/v1')
    await expect(api.setOptOut('@a b:test', true, channel)).resolves.toEqual({ optedOut: true, source: 'user' })
    expect(String(fetchImpl.mock.calls[0][0])).toBe(`https://harmony.test/bot-gateway/bridge/v2/matrix/privacy/optouts/%40a%20b%3Atest?channel_id=${channel}`)
    expect(fetchImpl.mock.calls[0][1]!.method).toBe('PUT')
    await api.setOptOut('@a:test', false)
    expect(fetchImpl.mock.calls[1][1]!.method).toBe('DELETE')
    expect(String(fetchImpl.mock.calls[1][0])).toBe('https://harmony.test/bot-gateway/bridge/v2/matrix/privacy/optouts/%40a%3Atest')
    await api.optOut('@a:test')
    expect(fetchImpl.mock.calls[2][1]!.method).toBe('GET')
  })
  it('reads opt-out lists larger than a megabyte', async () => {
    const ids = Array.from({ length: 20_000 }, (_, index) => `@person-with-a-long-name-${index}-${'x'.repeat(40)}:matrix.test`)
    await expect(setup({ version: '7', remote_user_ids: ids }).api.optOuts()).resolves.toEqual({ version: '7', ids })
    await expect(setup({ version: '7' }).api.optOuts()).rejects.toMatchObject({ transient: true })
  })
  it('erases one person by MXID and tells the codes of refusals apart', async () => {
    const { api, fetchImpl } = setup({ opted_out: true, erased: 4, more: true }, 202)
    await expect(api.erase('@a:test')).resolves.toEqual({ erased: 4, more: true })
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/bridge/v2/matrix/privacy/erase')
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toEqual({ user_id: '@a:test' })
    await expect(setup({ code: 'erase_recent', error: 'SECRET' }, 429).api.erase('@a:test')).rejects.toMatchObject({ errcode: 'erase_recent' })
    await expect(setup({ opted_out: 'yes' }).api.optOut('@a:test')).rejects.toThrow()
  })
  it('posts the status report as it is', async () => {
    const { api, fetchImpl } = setup({ ok: true })
    const report: StatusReport = { version: '0.2.0', connection: 'account', ready: true, user_id: '@a:test', homeserver: 'https://matrix.test', server_name: 'test',
      pending: 0, failed: 0, rooms: [], pairs: [], problems: [] }
    await api.status(report)
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/bridge/v2/matrix/status')
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toEqual(report)
  })
})
