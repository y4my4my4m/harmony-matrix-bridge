import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPair } from './BridgeApi.js'
import { HarmonyClient } from './HarmonyClient.js'
import { MatrixClient } from './MatrixClient.js'
import { PairManager } from './Pairs.js'
import { Relay } from './Relay.js'
import { Store } from './Store.js'

const userId = '11111111-1111-4111-8111-111111111111'
const alice = '@alice:matrix.test'
const bot = '@harmony_relay:matrix.test'
const channelOf = (index: number) => `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`
const roomOf = (index: number) => `!room${index}:matrix.test`

beforeEach(() => { vi.useFakeTimers() })
const stops: Array<() => void> = []
afterEach(async () => { for (const stop of stops.splice(0)) stop(); vi.useRealTimers() })

/** The real clients against a gateway and a homeserver that count what they are asked. */
async function bridge(pairs: number, options: { check?: boolean; mode?: 'ghost' | 'relay'; members?: number } = {}) {
  const { check = true, mode = 'ghost', members = 1 } = options
  const gateway: string[] = []
  const homeserver: string[] = []
  const member = { id: userId, username: 'alice', display_name: 'Alice', avatar_url: null, domain: 'harmony.test' }
  const list = [member, ...Array.from({ length: members - 1 }, (_, index) => ({ ...member, id: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`, username: `user${index}` }))]
  const harmonyFetch = async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input))
    const path = url.pathname.replace('/bot-gateway/api/v1/', '').replace(/channels\/[^/]+\//, '')
    gateway.push(`${init?.method} ${path}`)
    const index = Number(/channels\/22222222-2222-4222-8222-(\d{12})/.exec(url.pathname)?.[1] ?? 0)
    const asked = url.searchParams.get('user_id')
    const row = asked === null ? null : list.find(candidate => candidate.id === asked) ?? null
    if (path === 'bridge-check') return check ? Response.json({ platform: 'matrix', room_id: roomOf(index), sender_mode: mode, messages_encrypted: false, relay_allowed: asked === null ? null : true, member: row }) : new Response('', { status: 404 })
    if (path === 'bridge-platform') return Response.json({ platform: 'matrix' })
    if (path === 'encryption') return Response.json({ messages_encrypted: false })
    if (path === 'bridge-room') return Response.json({ room_id: roomOf(index), sender_mode: mode })
    if (path.startsWith('bridge-consent/')) return Response.json({ relay_allowed: true })
    if (path === 'bridge-members') return Response.json(row ? [row] : list)
    if (path === 'messages') return Response.json({ id: `h${gateway.length}` })
    return new Response('', { status: 404 })
  }
  const joined = new Set<string>()
  const matrixFetch = async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input))
    const path = decodeURIComponent(url.pathname).replace('/_matrix/client/v3/', '')
    homeserver.push(`${init?.method} ${path.replace(/rooms\/[^/]+\//, '').replace(/m\.room\.member\/.*/, 'm.room.member')}`)
    const self = url.searchParams.get('user_id')!
    const room = /rooms\/([^/]+)\//.exec(path)?.[1] ?? path.split('join/')[1]
    if (path.includes('/state/m.room.encryption')) return Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 })
    if (path.includes('/state/m.room.member/')) {
      const id = path.split('/state/m.room.member/')[1]
      if (init?.method === 'PUT') return Response.json({ event_id: '$state' })
      return id === alice || id === bot || joined.has(`${room} ${id}`) ? Response.json({ membership: 'join', displayname: 'Alice' }) : Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 })
    }
    if (path.includes('/state/')) return Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 })
    if (path.endsWith('/joined_members')) return Response.json({ joined: { [alice]: { display_name: 'Alice' }, [bot]: {} } })
    if (path === 'register') return Response.json({ user_id: 'x' })
    if (path === 'account/whoami') return Response.json({ user_id: self })
    if (path.startsWith('join/')) { joined.add(`${room} ${self}`); return Response.json({ room_id: room }) }
    if (path.includes('/send/')) return Response.json({ event_id: `$m${homeserver.length}` })
    return Response.json({})
  }
  const store = new Store(':memory:')
  const harmony = new HarmonyClient({ apiUrl: 'https://harmony.test/bot-gateway', gatewayUrl: 'wss://harmony.test', token: 'x', fetchImpl: harmonyFetch as typeof fetch })
  const matrix = new MatrixClient({ homeserverUrl: 'https://matrix.test', asToken: 'x', botUserId: bot, fetchImpl: matrixFetch as typeof fetch })
  const specs: ManagedPair[] = Array.from({ length: pairs }, (_, index) => ({ channelId: channelOf(index), channelName: 'c', roomId: roomOf(index), roomAlias: null, direction: 'both', senderMode: mode, encrypted: false }))
  const manager: PairManager = new PairManager({ harmony, matrix, store, ghosts: true, onReady: id => relay.requestMemberSync(id), onPairs: () => relay.wake(), report: () => {} })
  const relay: Relay = new Relay({ get pairs() { return manager.pairs }, harmony: {}, matrix: { serverName: 'matrix.test', senderLocalpart: 'harmony_relay' } }, store, harmony, matrix, () => {},
    { onRefused: id => manager.recheck(id) })
  stops.push(() => { manager.stop(); void relay.stop(); store.close() })
  manager.apply(specs)
  relay.start()
  manager.start()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(manager.pairs.every(pair => pair.state === 'ready')).toBe(true)
  let serial = 0
  const counted = async (work: () => void | Promise<void>, advance = 1_000) => {
    gateway.length = 0
    homeserver.length = 0
    await work()
    await vi.advanceTimersByTimeAsync(advance)
    return { gateway: [...gateway], homeserver: [...homeserver] }
  }
  return {
    store, relay, counted,
    native: (index = 0, text = 'hello') => relay.acceptHarmonyMessage({ id: `n${serial++}`, channel_id: channelOf(index), author: { id: userId, username: 'alice' }, content: text, metadata: {} }),
    incoming: (index = 0, text = 'hello') => relay.acceptTransaction(`t${serial}`, [{ type: 'm.room.message', event_id: `$e${serial++}`, room_id: roomOf(index), sender: alice, content: { msgtype: 'm.text', body: text } }]),
  }
}

describe('what a message costs', () => {
  it('asks Harmony twice and the homeserver three times for a text through a known ghost', async () => {
    const { counted, native, store } = await bridge(1)
    const { gateway, homeserver } = await counted(() => { native() })
    expect(gateway).toEqual(['GET bridge-check', 'GET bridge-check'])
    expect(homeserver).toEqual(['GET state/m.room.encryption/', 'GET state/m.room.encryption/', expect.stringContaining('PUT send/m.room.message/')])
    expect(store.counts()).toEqual({ pending: 0, failed: 0 })
  })
  it('asks the same for a text through the single sender', async () => {
    const { counted, native } = await bridge(1, { mode: 'relay' })
    const { gateway, homeserver } = await counted(() => { native() })
    expect(gateway).toHaveLength(2)
    expect(homeserver).toHaveLength(3)
  })
  it('asks Harmony twice and posts once for a text from Matrix, with three questions to the homeserver', async () => {
    const { counted, incoming } = await bridge(1)
    const { gateway, homeserver } = await counted(() => { incoming() })
    expect(gateway).toEqual(['GET bridge-check', 'GET bridge-check', 'POST messages'])
    expect(homeserver).toEqual(['GET state/m.room.encryption/', 'GET state/m.room.member', 'GET state/m.room.encryption/'])
  })
  it('prepares a ghost that is not there yet once, checking before each write', async () => {
    const { counted, native } = await bridge(1, { members: 101 })
    const first = await counted(() => { native() })
    expect(first.gateway.filter(request => request === 'GET bridge-check')).toHaveLength(4)
    expect(first.homeserver.filter(request => request.startsWith('POST register'))).toHaveLength(1)
    const second = await counted(() => { native() })
    expect(second.gateway).toHaveLength(2)
    expect(second.homeserver).toHaveLength(3)
  })
  it('asks a Harmony without bridge-check by the separate routes, five a check with a ghost', async () => {
    const { counted, native, incoming } = await bridge(1, { check: false })
    expect((await counted(() => { native() })).gateway).toHaveLength(10)
    expect((await counted(() => { incoming() })).gateway).toHaveLength(7)
  })
  it('delivers a burst without waiting for a tick', async () => {
    const { counted, native, store } = await bridge(1)
    await counted(() => { for (let index = 0; index < 50; index++) native() }, 0)
    expect(store.counts().pending).toBe(0)
  })
})

describe('what an idle pair costs', () => {
  it('is one refresh and one check in ten minutes', async () => {
    const { counted } = await bridge(1)
    const { gateway, homeserver } = await counted(() => {}, 10 * 60_000)
    expect(gateway.sort()).toEqual(['GET bridge-check', 'GET bridge-check', 'GET bridge-check', 'GET bridge-members'])
    expect(homeserver.length).toBeLessThanOrEqual(6)
  })
  it('is the same for each of a hundred', async () => {
    const { counted } = await bridge(100)
    const { gateway } = await counted(() => {}, 10 * 60_000)
    expect(gateway.length).toBeLessThanOrEqual(400)
  })
  it('does not list members for a pair with the single sender', async () => {
    const { counted } = await bridge(1, { mode: 'relay' })
    const { gateway } = await counted(() => {}, 10 * 60_000)
    expect(gateway.filter(request => request === 'GET bridge-members')).toEqual([])
  })
})
