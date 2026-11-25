import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LivePair, MatrixIdentity } from './config.js'
import { configSchema, ghostUserId } from './config.js'
import { separateCheck, type BridgeCheck, type SeparateChecks } from './HarmonyClient.js'
import { HttpError, ResponseTooLarge } from './http.js'
import { PrivacyDesk, type PrivacyApi } from './Privacy.js'
import { Relay, type MatrixEvent, type RelayOptions } from './Relay.js'
import { Store } from './Store.js'

const channelId = '22222222-2222-4222-8222-222222222222'
const otherChannel = '33333333-3333-4333-8333-333333333333'
const userId = '11111111-1111-4111-8111-111111111111'
const roomId = '!test:matrix.test'
const alice = '@alice:matrix.test'
const bot = '@harmony_relay:matrix.test'
const stores: Store[] = []
afterEach(() => { stores.splice(0).forEach(store => store.close()); vi.useRealTimers() })

function pair(overrides: Partial<LivePair> = {}): LivePair {
  return { harmonyChannelId: channelId, matrixRoomId: roomId, direction: 'both', senderMode: 'relay', ...overrides }
}
function setup(options: { pairs?: LivePair[]; privacy?: Partial<Record<keyof PrivacyApi, ReturnType<typeof vi.fn>>>; identity?: MatrixIdentity; extra?: RelayOptions; mode?: 'ghost' | 'relay' } = {}) {
  const settings = { pairs: options.pairs ?? [pair()], harmony: {}, matrix: options.identity ?? { serverName: 'matrix.test', senderLocalpart: 'harmony_relay' } as MatrixIdentity }
  const store = new Store(':memory:')
  stores.push(store)
  const members = [{ id: userId, username: 'Alice', display_name: 'Room Alice', avatar_url: null, domain: 'harmony.test' }]
  const harmony = { check: vi.fn((channelId: string, userId?: string, named?: boolean): Promise<BridgeCheck> => separateCheck(harmony as unknown as SeparateChecks, channelId, userId, named)),
    sendMessage: vi.fn().mockResolvedValue({ id: 'h-copy' }), canReplyTo: vi.fn().mockResolvedValue(true), channelIsPlaintext: vi.fn().mockResolvedValue(true),
    requireMatrixBridge: vi.fn().mockResolvedValue(undefined), relayAllowed: vi.fn().mockResolvedValue(true),
    uploadBridgeAvatar: vi.fn().mockResolvedValue('https://storage.test/avatar.png'),
    bridgeRoom: vi.fn().mockImplementation(async () => ({ room_id: roomId, sender_mode: options.mode ?? 'relay' })),
    bridgeMembers: vi.fn().mockResolvedValue(members),
    nativeAvatar: vi.fn().mockResolvedValue({ data: 'aW1hZ2U=', content_type: 'image/png' }), publishMatrixMembers: vi.fn(),
    downloadFile: vi.fn().mockResolvedValue({ bytes: Buffer.from('bytes'), name: 'a.txt', contentType: 'text/plain' }),
    uploadFile: vi.fn().mockResolvedValue({ type: 'file', path: 'c/x' }) }
  const matrix = { sendMessage: vi.fn().mockResolvedValue({ event_id: '$m-copy' }), roomIsPlaintext: vi.fn().mockResolvedValue(true),
    roomMember: vi.fn().mockResolvedValue({ display_name: 'Room Alice' }), avatarThumbnail: vi.fn().mockResolvedValue({ data: 'aW1hZ2U=', content_type: 'image/png' }),
    registerGhost: vi.fn().mockResolvedValue(undefined), joinGhost: vi.fn().mockResolvedValue(undefined), leaveGhost: vi.fn().mockResolvedValue(undefined),
    uploadAvatar: vi.fn().mockResolvedValue('mxc://matrix.test/native'), roomMembers: vi.fn().mockResolvedValue([{ id: alice }]),
    downloadFile: vi.fn().mockResolvedValue({ bytes: Buffer.from('bytes'), name: 'a.txt', contentType: 'text/plain' }),
    uploadFile: vi.fn().mockResolvedValue('mxc://matrix.test/uploaded'), sendFile: vi.fn().mockResolvedValue({ event_id: '$file-copy' }) }
  const api = { optOuts: vi.fn().mockResolvedValue({ version: '1', ids: [] }), optOut: vi.fn().mockResolvedValue({ optedOut: false, source: null }),
    setOptOut: vi.fn().mockImplementation(async (_id: string, optedOut: boolean) => ({ optedOut, source: optedOut ? 'user' : null })),
    erase: vi.fn().mockResolvedValue({ erased: 3, more: false }), ...options.privacy }
  const privacy = new PrivacyDesk(api as unknown as PrivacyApi, { oneServer: true })
  const reports: string[] = []
  const relay = new Relay(settings, store, harmony, matrix, message => reports.push(message), { privacy, ...options.extra })
  return { settings, store, harmony, matrix, api, privacy, relay, reports, members }
}
function event(overrides: Partial<MatrixEvent> = {}): MatrixEvent {
  return { type: 'm.room.message', event_id: '$one', room_id: roomId, sender: alice, content: { msgtype: 'm.text', body: 'hello' }, ...overrides }
}
const say = (body: string, id = `$${body}`, extra: Record<string, unknown> = {}) => event({ event_id: id, content: { msgtype: 'm.text', body, ...extra } })
function message(overrides: Record<string, unknown> = {}) {
  return { id: 'h-one', channel_id: channelId, author: { id: userId, username: 'Alice' }, content: 'hello', metadata: {}, ...overrides }
}

describe('Relay without lists', () => {
  it('relays everyone in both directions when config.json names no one', async () => {
    const config = configSchema.parse({ harmony: { apiUrl: 'https://h.test', gatewayUrl: 'wss://h.test' },
      matrix: { homeserverUrl: 'https://matrix.test', serverName: 'matrix.test', applicationServiceUrl: 'http://127.0.0.1:9009' },
      pairs: [{ harmonyChannelId: channelId, matrixRoomId: roomId }] })
    const { store, harmony, matrix } = setup()
    const relay = new Relay(config, store, harmony, matrix)
    relay.acceptTransaction('one', [event({ sender: '@someone:elsewhere.test' })])
    expect(relay.acceptHarmonyMessage(message({ author: { id: '99999999-9999-4999-8999-999999999999', username: 'Zed' } }))).toBe(true)
    await relay.tick(); await relay.tick()
    expect(harmony.sendMessage.mock.calls[0][2].bridge_author.id).toBe('@someone:elsewhere.test')
    expect(matrix.sendMessage.mock.calls[0][2]).toBe('[Zed · Harmony] hello')
  })
  it('still refuses bots, webhooks, bridged authors and authors without a profile ID', () => {
    const { relay, store } = setup()
    for (const override of [{ author: { id: userId, bot: true } }, { author: { id: userId, bot: true, webhook: true } }, { author: null },
      { author: { id: '@alice:matrix.test' } }, { author: { id: '123456789012345678', discord_user: true } }, { metadata: { bridge_source: 'matrix' } },
      { metadata: { discord_user: { id: '1' } } }, { metadata: { matrix_relay: {} } }]) {
      expect(relay.acceptHarmonyMessage(message(override))).toBe(false)
    }
    expect(store.counts().pending).toBe(0)
  })
  it.each(['ghost', 'relay'] as const)('fails a queued job whose sender is no profile ID, asking nobody and stopping nothing (%s)', async mode => {
    const { relay, store, matrix, harmony } = setup({ mode })
    store.enqueue({ direction: 'to_matrix', sourceId: 'bad', channelId, roomId, payload: { sender: 'undefined', name: 'x', body: 'hello' } })
    await relay.tick()
    expect(relay.isHealthy).toBe(true)
    expect(harmony.requireMatrixBridge).not.toHaveBeenCalled()
    expect(matrix.sendMessage).not.toHaveBeenCalled()
    expect(store.counts()).toEqual({ pending: 0, failed: 1 })
  })
})

describe('pairs that come and go', () => {
  it('runs with no pair at all', async () => {
    const { relay, settings, harmony } = setup({ pairs: [] })
    relay.requestMemberSync()
    await relay.tick()
    expect(relay.isHealthy).toBe(true)
    settings.pairs = [pair()]
    relay.acceptTransaction('one', [event()])
    await relay.tick()
    expect(harmony.sendMessage).toHaveBeenCalledOnce()
  })
  it('keeps the events of a joining pair and delivers them once it is ready, without holding up other pairs', async () => {
    const { relay, settings, store, harmony, matrix } = setup({ pairs: [pair({ state: 'joining' }),
      pair({ harmonyChannelId: otherChannel, matrixRoomId: '!other:matrix.test', state: 'ready' })] })
    harmony.bridgeRoom.mockImplementation(async (id: string) => ({ room_id: id === channelId ? roomId : '!other:matrix.test', sender_mode: 'relay' }))
    relay.acceptTransaction('one', [event(), event({ event_id: '$two', room_id: '!other:matrix.test' })])
    expect(relay.acceptHarmonyMessage(message())).toBe(true)
    await relay.tick(); await relay.tick(); await relay.tick()
    expect(harmony.sendMessage.mock.calls.map(call => call[0])).toEqual([otherChannel])
    expect(matrix.sendMessage).not.toHaveBeenCalled()
    expect(store.counts()).toEqual({ pending: 2, failed: 0 })
    settings.pairs = settings.pairs.map(pair => ({ ...pair, state: 'ready' as const }))
    await relay.tick(); await relay.tick()
    expect(harmony.sendMessage).toHaveBeenCalledTimes(2)
    expect(matrix.sendMessage).toHaveBeenCalledOnce()
  })
  it('takes nothing but the encryption fence for a pair in error', async () => {
    const { relay, store, harmony } = setup({ pairs: [pair({ state: 'error' })] })
    relay.acceptTransaction('one', [event(), say('!bridge-privacy status'), { type: 'm.room.encryption', room_id: roomId, state_key: '' }])
    expect(relay.acceptHarmonyMessage(message())).toBe(false)
    expect(store.counts().pending).toBe(0)
    expect(store.isRoomBlocked(roomId)).toBe(true)
    await relay.tick()
    expect(harmony.sendMessage).not.toHaveBeenCalled()
  })
  it('raises the durable fence for a joining pair before its messages are delivered', async () => {
    const { relay, settings, store, harmony } = setup({ pairs: [pair({ state: 'joining' })] })
    relay.acceptTransaction('one', [event(), { type: 'm.room.encryption', room_id: roomId, state_key: '' }])
    settings.pairs = [pair({ state: 'ready' })]
    await relay.tick()
    expect(harmony.sendMessage).not.toHaveBeenCalled()
    expect(store.counts().failed).toBe(1)
  })
  it.each(['removed', 'error'])('fails the queued jobs of a pair that is %s', async state => {
    const { relay, settings, store, harmony, matrix } = setup()
    relay.acceptTransaction('one', [event()])
    relay.acceptHarmonyMessage(message())
    settings.pairs = state === 'removed' ? [] : [pair({ state: 'error' })]
    await relay.tick(); await relay.tick()
    expect(harmony.sendMessage).not.toHaveBeenCalled()
    expect(matrix.sendMessage).not.toHaveBeenCalled()
    expect(store.counts()).toEqual({ pending: 0, failed: 2 })
  })
  it('does not transfer a file that a pair removal or error overtakes', async () => {
    const { relay, settings, harmony, matrix, store } = setup()
    matrix.downloadFile.mockImplementation(async () => { settings.pairs = [pair({ state: 'error' })]; return { bytes: Buffer.from('x'), name: 'a.txt', contentType: 'text/plain' } })
    relay.acceptTransaction('file', [event({ content: { msgtype: 'm.file', body: 'a.txt', filename: 'a.txt', url: 'mxc://matrix.test/a' } })])
    await relay.tick()
    expect(harmony.uploadFile).not.toHaveBeenCalled()
    expect(harmony.sendMessage).not.toHaveBeenCalled()
    expect(store.counts().failed).toBe(1)
  })
  it('does not copy messages older than the pair, whenever the homeserver delivers them', () => {
    const since = 1_800_000_000_000
    const { relay, store } = setup({ pairs: [pair({ since })] })
    relay.acceptTransaction('old', [event({ event_id: '$old', origin_server_ts: since - 3 * 86_400_000 }),
      { ...say('!bridge-privacy erase confirm', '$command'), origin_server_ts: since - 3 * 86_400_000 }])
    expect(store.counts().pending).toBe(0)
    relay.acceptTransaction('new', [event({ event_id: '$skewed', origin_server_ts: since - 60_000 }), event({ event_id: '$new', origin_server_ts: since + 1 })])
    expect(store.counts().pending).toBe(2)
  })
  it('lets the ghosts of rooms that are no pair anymore leave, one room a tick, and retries', async () => {
    vi.useFakeTimers()
    const { relay, store, matrix, settings } = setup({ mode: 'ghost' })
    const ghost = ghostUserId(settings, userId)
    store.reserveGhost(ghost, userId); store.registerGhost(ghost)
    for (const room of [roomId, '!gone-a:test', '!gone-b:test']) store.trackGhostRoom(room, ghost)
    await relay.tick()
    expect(matrix.leaveGhost).not.toHaveBeenCalled()
    matrix.leaveGhost.mockRejectedValueOnce(new HttpError('busy', true, 503))
    relay.requestGhostCleanup()
    await relay.tick()
    expect(store.ghostRooms()).toEqual(['!gone-a:test', '!gone-b:test', roomId])
    await relay.tick(); await relay.tick(); await relay.tick()
    expect(store.ghostRooms()).toEqual(['!gone-a:test', roomId])
    vi.advanceTimersByTime(60_000)
    await relay.tick(); await relay.tick()
    expect(store.ghostRooms()).toEqual([roomId])
    expect(matrix.leaveGhost).toHaveBeenCalledTimes(3)
    await relay.tick()
    expect(matrix.leaveGhost).toHaveBeenCalledTimes(3)
    expect(relay.isHealthy).toBe(true)
  })
  it('forgets a ghost that is no longer in its room, and keeps one the homeserver would not let leave', async () => {
    const { relay, store, matrix, settings } = setup({ pairs: [] })
    const ghost = ghostUserId(settings, userId)
    store.reserveGhost(ghost, userId); store.registerGhost(ghost)
    store.trackGhostRoom('!gone:test', ghost)
    matrix.leaveGhost.mockRejectedValue(new HttpError('refused', false, 403))
    relay.requestGhostCleanup()
    await relay.tick()
    expect(store.ghostRooms()).toEqual(['!gone:test'])
    matrix.roomMember.mockRejectedValue(new HttpError('not joined', false))
    relay.requestGhostCleanup()
    await relay.tick()
    expect(store.ghostRooms()).toEqual([])
  })
})

describe('ghosts on first speech', () => {
  const many = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
    username: `user${index}`, display_name: null, avatar_url: null, domain: 'harmony.test' }))
  it('prepares ghosts ahead of speech with 100 eligible members, ten a pass, and not again while nothing changes', async () => {
    const { relay, harmony, matrix } = setup({ mode: 'ghost' })
    harmony.bridgeMembers.mockResolvedValue(many(100))
    relay.requestMemberSync()
    await relay.tick()
    expect(matrix.joinGhost).toHaveBeenCalledTimes(10)
    for (let pass = 0; pass < 12; pass++) await relay.tick()
    expect(matrix.joinGhost).toHaveBeenCalledTimes(100)
    relay.requestMemberSync()
    await relay.tick()
    expect(matrix.joinGhost).toHaveBeenCalledTimes(100)
    harmony.bridgeMembers.mockResolvedValue(many(100).map((member, index) => index ? member : { ...member, display_name: 'New name' }))
    relay.requestMemberSync()
    await relay.tick()
    expect(matrix.joinGhost).toHaveBeenCalledTimes(101)
    expect(matrix.joinGhost.mock.calls[100][2].displayname).toBe('New name')
  })
  it('prepares none ahead with 101, and the speaker\'s alone when they speak', async () => {
    const { relay, harmony, matrix, store, settings } = setup({ mode: 'ghost' })
    const list = many(101)
    harmony.bridgeMembers.mockImplementation(async (_channel: string, id?: string) => id ? list.filter(member => member.id === id) : list)
    relay.requestMemberSync()
    await relay.tick()
    expect(matrix.registerGhost).not.toHaveBeenCalled()
    relay.acceptHarmonyMessage(message({ author: { id: list[7].id, username: 'user7' } }))
    await relay.tick()
    expect(matrix.registerGhost).toHaveBeenCalledExactlyOnceWith(ghostUserId(settings, list[7].id), false)
    expect(store.roomGhosts(roomId)).toEqual([ghostUserId(settings, list[7].id)])
    expect(matrix.sendMessage.mock.calls[0][3].sender).toBe(ghostUserId(settings, list[7].id))
    expect(harmony.bridgeMembers.mock.calls.filter(call => call[1] === undefined)).toHaveLength(1)
    expect(harmony.relayAllowed).toHaveBeenCalledWith(channelId, list[7].id)
  })
  it('makes the ghost of someone who left or opted out leave a large channel\'s room too', async () => {
    const { relay, harmony, matrix, settings } = setup({ mode: 'ghost' })
    const list = many(101)
    harmony.bridgeMembers.mockImplementation(async (_channel: string, id?: string) => id ? list.filter(member => member.id === id) : list)
    relay.acceptHarmonyMessage(message({ author: { id: list[7].id, username: 'user7' } }))
    await relay.tick()
    harmony.bridgeMembers.mockResolvedValue(list.filter((_, index) => index !== 7))
    relay.requestMemberSync()
    await relay.tick()
    expect(matrix.leaveGhost).toHaveBeenCalledExactlyOnceWith(roomId, ghostUserId(settings, list[7].id))
  })
  it('lets nobody whose consent is gone speak, however small the channel', async () => {
    const { relay, harmony, matrix, store } = setup({ mode: 'ghost' })
    harmony.relayAllowed.mockResolvedValue(false)
    relay.acceptHarmonyMessage(message())
    await relay.tick()
    expect(matrix.registerGhost).not.toHaveBeenCalled()
    expect(matrix.sendMessage).not.toHaveBeenCalled()
    expect(store.counts().failed).toBe(1)
  })
  it('reports ghosts the homeserver refuses and still lists and relays Matrix people', async () => {
    const onGhosts = vi.fn()
    const { relay, harmony, matrix } = setup({ mode: 'ghost', extra: { onGhosts } })
    matrix.registerGhost.mockRejectedValue(new HttpError('exclusive', false, 400, 'M_EXCLUSIVE'))
    relay.requestMemberSync()
    await relay.tick()
    expect(onGhosts).toHaveBeenLastCalledWith(channelId, false)
    expect(harmony.publishMatrixMembers.mock.calls.at(-1)![1]).toHaveLength(1)
    relay.acceptTransaction('one', [event()])
    await relay.tick()
    expect(harmony.sendMessage).toHaveBeenCalledOnce()
    matrix.registerGhost.mockResolvedValue(undefined)
    relay.requestMemberSync()
    await relay.tick()
    expect(onGhosts).toHaveBeenLastCalledWith(channelId, true)
  })
  it('is not held up by one member whose consent changed during the pass', async () => {
    const { relay, harmony, matrix } = setup({ mode: 'ghost' })
    const list = many(3)
    harmony.bridgeMembers.mockResolvedValue(list)
    harmony.relayAllowed.mockImplementation(async (_channel: string, id: string) => id !== list[0].id)
    relay.requestMemberSync()
    await relay.tick()
    expect(matrix.joinGhost).toHaveBeenCalledTimes(2)
  })
})

describe('an ordinary account', () => {
  const account: MatrixIdentity = { serverName: 'matrix.test', userId: '@community:matrix.test' }
  it('relays through the account in every stored mode, and never prepares or removes a ghost', async () => {
    const { relay, matrix, harmony, store } = setup({ identity: account, mode: 'ghost' })
    store.reserveGhost('@harmony_relay_h_11111111111141118111111111111111:matrix.test', userId)
    store.trackGhostRoom('!old:matrix.test', '@harmony_relay_h_11111111111141118111111111111111:matrix.test')
    relay.requestMemberSync()
    relay.requestGhostCleanup()
    relay.acceptHarmonyMessage(message())
    await relay.tick()
    expect(matrix.sendMessage.mock.calls[0][2]).toBe('[Alice · Harmony] hello')
    expect(matrix.sendMessage.mock.calls[0][3].sender).toBe('@community:matrix.test')
    expect(matrix.registerGhost).not.toHaveBeenCalled()
    expect(matrix.leaveGhost).not.toHaveBeenCalled()
    expect(harmony.publishMatrixMembers.mock.calls[0][1]).toHaveLength(1)
    expect(relay.isHealthy).toBe(true)
  })
  it('never relays its own messages back', () => {
    const { relay, store } = setup({ identity: account })
    relay.acceptSync('@community:matrix.test', { nextBatch: 's1', rooms: [roomId], events: [event({ sender: '@community:matrix.test' })], history: [] })
    expect(store.counts().pending).toBe(0)
  })
  it('holds the consent and encryption checks of every send', async () => {
    for (const refusal of ['consent', 'matrix', 'harmony', 'binding', 'fence']) {
      const { relay, matrix, harmony, store } = setup({ identity: account })
      relay.acceptHarmonyMessage(message())
      if (refusal === 'consent') harmony.relayAllowed.mockResolvedValue(false)
      if (refusal === 'matrix') matrix.roomIsPlaintext.mockResolvedValue(false)
      if (refusal === 'harmony') harmony.channelIsPlaintext.mockResolvedValue(false)
      if (refusal === 'binding') harmony.requireMatrixBridge.mockRejectedValue(new HttpError('revoked', false, 403))
      if (refusal === 'fence') relay.acceptSync('@community:matrix.test', { nextBatch: 's1', rooms: [roomId], events: [], history: [{ type: 'm.room.encryption', room_id: roomId }] })
      await relay.tick()
      expect(matrix.sendMessage, refusal).not.toHaveBeenCalled()
      expect(store.counts().failed, refusal).toBe(1)
    }
  })
  it('commits the sync token with the jobs and fences of its response, or not at all', () => {
    const { relay, store } = setup({ identity: account })
    relay.acceptSync('@community:matrix.test', { nextBatch: 's1', rooms: [roomId], events: [event()], history: [event({ event_id: '$history' })] })
    expect(store.syncState('@community:matrix.test')).toEqual({ nextBatch: 's1', rooms: [roomId] })
    expect(store.counts().pending).toBe(1)
    expect(store.nextJob()!.sourceId).toBe('$one')
    vi.spyOn(store as unknown as { insert: () => boolean }, 'insert').mockImplementation(() => { throw new Error('Pending job quota exceeded') })
    expect(() => relay.acceptSync('@community:matrix.test', { nextBatch: 's2', rooms: [roomId], events: [event({ event_id: '$two' })],
      history: [{ type: 'm.room.encryption', room_id: roomId }] })).toThrow()
    expect(store.syncState('@community:matrix.test')!.nextBatch).toBe('s1')
    expect(store.isRoomBlocked(roomId)).toBe(false)
  })
  it.each(['M_UNKNOWN_TOKEN', 'M_MISSING_TOKEN'])('keeps messages while the homeserver refuses the token (%s)', async errcode => {
    vi.useFakeTimers()
    const { relay, matrix, store } = setup({ identity: account })
    relay.acceptHarmonyMessage(message())
    matrix.roomIsPlaintext.mockRejectedValue(new HttpError('expired', false, 401, errcode))
    await relay.tick(); await relay.tick()
    expect(matrix.roomIsPlaintext).toHaveBeenCalledOnce()
    for (let round = 0; round < 10; round++) {
      vi.advanceTimersByTime(60_000)
      await relay.tick(); await relay.tick()
    }
    expect(store.counts()).toEqual({ pending: 1, failed: 0 })
    matrix.roomIsPlaintext.mockResolvedValue(true)
    vi.advanceTimersByTime(60_000)
    await relay.tick()
    expect(matrix.sendMessage).toHaveBeenCalledOnce()
  })
  it('waits out the homeserver\'s rate limit in order, without spending attempts or stopping the other direction', async () => {
    vi.useFakeTimers()
    const { relay, matrix, harmony, store } = setup({ identity: account })
    for (const id of ['h-one', 'h-two']) relay.acceptHarmonyMessage(message({ id, content: id }))
    for (let round = 0; round < 10; round++) {
      matrix.sendMessage.mockRejectedValueOnce(new HttpError('limited', true, 429, 'M_LIMIT_EXCEEDED', 5_000))
      await relay.tick()
      await relay.tick()
      vi.advanceTimersByTime(5_000)
    }
    expect(matrix.sendMessage).toHaveBeenCalledTimes(10)
    matrix.sendMessage.mockRejectedValueOnce(new HttpError('limited', true, 429, 'M_LIMIT_EXCEEDED', 5_000))
    await relay.tick()
    relay.acceptTransaction('one', [event()])
    await relay.tick()
    expect(harmony.sendMessage).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(5_000)
    await relay.tick(); await relay.tick()
    expect(matrix.sendMessage.mock.calls.slice(-2).map(call => call[2])).toEqual(['[Alice · Harmony] h-one', '[Alice · Harmony] h-two'])
    expect(store.counts()).toEqual({ pending: 0, failed: 0 })
  })
})

describe('Matrix people who opted out', () => {
  it('drops their messages when they arrive, when they are queued and when Harmony refuses them', async () => {
    const { relay, privacy, harmony, store } = setup()
    relay.acceptTransaction('queued', [event()])
    privacy.noteOptedOut(channelId, alice)
    relay.acceptTransaction('later', [event({ event_id: '$two' })])
    expect(store.counts().pending).toBe(1)
    await relay.tick()
    expect(harmony.sendMessage).not.toHaveBeenCalled()
    expect(store.counts()).toEqual({ pending: 0, failed: 1 })
  })
  it('learns from 403 BRIDGE_AUTHOR_OPTED_OUT and sends nothing more of theirs', async () => {
    const { relay, privacy, harmony, store, reports } = setup()
    harmony.sendMessage.mockRejectedValueOnce(new HttpError('refused', false, 403, 'BRIDGE_AUTHOR_OPTED_OUT'))
    relay.acceptTransaction('one', [event(), event({ event_id: '$two' })])
    await relay.tick(); await relay.tick()
    expect(harmony.sendMessage).toHaveBeenCalledOnce()
    expect(privacy.optedOut(channelId, alice)).toBe(true)
    expect(store.counts()).toEqual({ pending: 0, failed: 2 })
    expect(reports).toEqual([])
  })
  it('leaves them out of member lists and of mentions', async () => {
    const { relay, privacy, harmony, matrix } = setup()
    matrix.roomMembers.mockResolvedValue([{ id: alice }, { id: '@bob:matrix.test' }])
    privacy.noteOptedOut(channelId, alice)
    relay.requestMemberSync()
    await relay.tick()
    expect(harmony.publishMatrixMembers.mock.calls[0][1].map((member: { id: string }) => member.id)).toEqual(['@bob:matrix.test'])
    relay.acceptHarmonyMessage(message({ content_raw: [{ type: 'mention', userId: alice, username: 'alice', isBridged: true, bridgeSource: 'matrix' }] }))
    await relay.tick()
    expect(matrix.sendMessage.mock.calls[0][3].userIds).toEqual([])
  })
  it('stops a file whose author opts out during the download', async () => {
    const { relay, privacy, harmony, matrix } = setup()
    matrix.downloadFile.mockImplementation(async () => { privacy.noteOptedOut(channelId, alice); return { bytes: Buffer.from('x'), name: 'a.txt', contentType: 'text/plain' } })
    relay.acceptTransaction('file', [event({ content: { msgtype: 'm.file', body: 'a.txt', filename: 'a.txt', url: 'mxc://matrix.test/a' } })])
    await relay.tick()
    expect(harmony.uploadFile).not.toHaveBeenCalled()
    expect(harmony.sendMessage).not.toHaveBeenCalled()
  })
})

describe('!bridge-privacy', () => {
  it.each([['opt-out', true, 'no longer go to Harmony'], ['opt-in', false, 'go to Harmony again']] as const)('answers %s to the person who asked, never relays it', async (command, out, words) => {
    const { relay, api, harmony, matrix, privacy } = setup()
    relay.acceptTransaction('one', [say(`!bridge-privacy ${command}`, '$ask')])
    await relay.tick()
    expect(api.setOptOut).toHaveBeenCalledExactlyOnceWith(alice, out, undefined)
    expect(privacy.optedOut(channelId, alice)).toBe(out)
    expect(harmony.sendMessage).not.toHaveBeenCalled()
    const [room, transaction, body, options] = matrix.sendMessage.mock.calls[0]
    expect(room).toBe(roomId)
    expect(transaction).toMatch(/^[a-f0-9]{64}$/)
    expect(body).toContain(words)
    expect(options).toEqual({ notice: true, userIds: [alice], replyTo: '$ask' })
    await relay.tick()
    expect(matrix.sendMessage).toHaveBeenCalledOnce()
  })
  it('says how it stands, and that a manager\'s removal is not the person\'s to lift', async () => {
    const { relay, matrix, privacy } = setup({ privacy: { optOut: vi.fn().mockResolvedValue({ optedOut: true, source: 'manager' }),
      setOptOut: vi.fn().mockResolvedValue({ optedOut: true, source: 'manager' }) } })
    relay.acceptTransaction('one', [say('!bridge-privacy status'), say('!bridge-privacy opt-in')])
    await relay.tick(); await relay.tick()
    for (const call of matrix.sendMessage.mock.calls) expect(call[2]).toContain('managers decided that')
    expect(privacy.optedOut(channelId, alice)).toBe(true)
  })
  it('erases only after a confirmation', async () => {
    const { relay, api, matrix, privacy } = setup()
    relay.acceptTransaction('one', [say('!bridge-privacy erase')])
    await relay.tick()
    expect(api.erase).not.toHaveBeenCalled()
    expect(matrix.sendMessage.mock.calls[0][2]).toContain('!bridge-privacy erase confirm')
    relay.acceptTransaction('two', [say('!bridge-privacy erase confirm')])
    await relay.tick()
    expect(api.erase).toHaveBeenCalledExactlyOnceWith(alice, undefined)
    expect(matrix.sendMessage.mock.calls[1][2]).toContain('3 of your messages on Harmony deleted')
    expect(privacy.optedOut(channelId, alice)).toBe(true)
    relay.acceptTransaction('three', [event({ event_id: '$after' })])
    await relay.tick()
    expect(matrix.sendMessage).toHaveBeenCalledTimes(2)
  })
  it('answers an erase asked again too soon', async () => {
    const { relay, matrix } = setup({ privacy: { erase: vi.fn().mockRejectedValue(new HttpError('recent', true, 429, 'erase_recent', 42_000)) } })
    relay.acceptTransaction('one', [say('!bridge-privacy erase confirm')])
    await relay.tick()
    expect(matrix.sendMessage.mock.calls[0][2]).toContain('42 seconds')
  })
  it.each([['!bridge-privacy', {}], ['!bridge-privacy what is this', {}], ['!BRIDGE-PRIVACY help', {}],
    ['> <@bob:matrix.test> earlier\n\n!bridge-privacy', { 'm.relates_to': { 'm.in_reply_to': { event_id: '$parent' } } }],
    ['!bridge-privacy', { 'm.relates_to': { rel_type: 'm.thread', event_id: '$root', 'm.in_reply_to': { event_id: '$root' } } }]])('explains itself for %j', async (body, extra) => {
    const { relay, matrix, api, harmony } = setup()
    relay.acceptTransaction('one', [say(body, '$ask', extra)])
    await relay.tick()
    expect(matrix.sendMessage.mock.calls[0][2]).toContain('opt-out stops your messages')
    expect(api.setOptOut).not.toHaveBeenCalled()
    expect(harmony.sendMessage).not.toHaveBeenCalled()
  })
  it('is open to people the lists leave out and in rooms that only receive', async () => {
    const { relay, api, settings } = setup({ pairs: [pair({ direction: 'to_matrix' })] })
    Object.assign(settings.matrix, { allowedUserIds: ['@else:matrix.test'] })
    relay.acceptTransaction('one', [say('!bridge-privacy opt-out')])
    await relay.tick()
    expect(api.setOptOut).toHaveBeenCalledOnce()
  })
  it('obeys neither the bridge, its ghosts, notices nor edits', async () => {
    const { relay, store, settings } = setup()
    relay.acceptTransaction('one', [event({ event_id: '$1', sender: bot, content: { msgtype: 'm.text', body: '!bridge-privacy opt-out' } }),
      event({ event_id: '$2', sender: ghostUserId(settings, userId), content: { msgtype: 'm.text', body: '!bridge-privacy opt-out' } }),
      event({ event_id: '$3', content: { msgtype: 'm.notice', body: '!bridge-privacy opt-out' } }),
      event({ event_id: '$4', content: { msgtype: 'm.text', body: '* !bridge-privacy opt-out', 'm.new_content': { msgtype: 'm.text', body: '!bridge-privacy opt-out' }, 'm.relates_to': { rel_type: 'm.replace', event_id: '$0' } } })])
    expect(store.counts().pending).toBe(0)
  })
  it('answers one person at most five times a minute, and ignores the rest without relaying it', async () => {
    const { relay, matrix, store, harmony } = setup()
    relay.acceptTransaction('flood', Array.from({ length: 30 }, (_, index) => say('!bridge-privacy status', `$${index}`)))
    expect(store.counts().pending).toBe(5)
    relay.acceptTransaction('other', [event({ event_id: '$bob', sender: '@bob:matrix.test', content: { msgtype: 'm.text', body: '!bridge-privacy status' } })])
    for (let index = 0; index < 8; index++) await relay.tick()
    expect(matrix.sendMessage).toHaveBeenCalledTimes(6)
    expect(harmony.sendMessage).not.toHaveBeenCalled()
  })
  it('keeps acting on commands a crowd sends while a room gets at most twenty answers a minute', async () => {
    const { relay, matrix, api, store } = setup()
    relay.acceptTransaction('crowd', Array.from({ length: 25 }, (_, index) => event({ event_id: `$${index}`, sender: `@p${index}:matrix.test`,
      content: { msgtype: 'm.text', body: '!bridge-privacy opt-out' } })))
    for (let index = 0; index < 25; index++) await relay.tick()
    expect(api.setOptOut).toHaveBeenCalledTimes(25)
    expect(matrix.sendMessage).toHaveBeenCalledTimes(20)
    expect(store.counts()).toEqual({ pending: 0, failed: 0 })
  })
  it('survives a restart and retries a Harmony that does not answer, then says it failed', async () => {
    vi.useFakeTimers()
    const { relay, api, matrix, store } = setup({ privacy: { setOptOut: vi.fn().mockRejectedValue(new HttpError('down', true, 503)) } })
    relay.acceptTransaction('one', [say('!bridge-privacy opt-out')])
    for (let attempt = 0; attempt < 8; attempt++) { await relay.tick(); vi.advanceTimersByTime(60_000) }
    expect(api.setOptOut).toHaveBeenCalledTimes(8)
    expect(matrix.sendMessage).toHaveBeenCalledOnce()
    expect(matrix.sendMessage.mock.calls[0][2]).toContain('did not work')
    expect(store.counts()).toEqual({ pending: 0, failed: 0 })
  })
  it('says so on a Harmony without the routes', async () => {
    const { relay, matrix, privacy, api } = setup()
    privacy.supported = false
    relay.acceptTransaction('one', [say('!bridge-privacy opt-out')])
    await relay.tick()
    expect(api.setOptOut).not.toHaveBeenCalled()
    expect(matrix.sendMessage.mock.calls[0][2]).toContain('does not offer that yet')
  })
  it.each(['matrix', 'harmony', 'fence', 'binding'])('opts the person out and answers nothing into a room whose %s check fails', async side => {
    const { relay, api, matrix, harmony } = setup()
    relay.acceptTransaction('one', [say('!bridge-privacy opt-out')])
    if (side === 'matrix') matrix.roomIsPlaintext.mockResolvedValue(false)
    if (side === 'harmony') harmony.channelIsPlaintext.mockResolvedValue(false)
    if (side === 'fence') api.setOptOut.mockImplementation(async () => {
      relay.acceptTransaction('encrypt', [{ type: 'm.room.encryption', room_id: roomId }])
      return { optedOut: true, source: 'user' }
    })
    if (side === 'binding') harmony.requireMatrixBridge.mockRejectedValue(new HttpError('revoked', false, 403))
    await relay.tick()
    expect(api.setOptOut).toHaveBeenCalledTimes(side === 'binding' ? 0 : 1)
    expect(matrix.sendMessage).not.toHaveBeenCalled()
  })
  it('does not answer for a message it was never about', async () => {
    const { relay, store } = setup()
    relay.acceptTransaction('one', [say('try !bridge-privacy opt-out'), say('!bridge-privacyopt-out'), event({ event_id: '$x', type: 'm.sticker', content: { msgtype: 'm.text', body: '!bridge-privacy' } })])
    expect(store.counts().pending).toBe(2)
    expect(store.nextJob()!.payload.command).toBeUndefined()
  })
})

describe('members and avatars at scale', () => {
  it('keeps an avatar per Harmony server, and copies it once within one', async () => {
    const pairs = [pair(), pair({ harmonyChannelId: otherChannel, matrixRoomId: '!other:matrix.test' })]
    for (const [scope, copies] of [[undefined, 2], [() => 'server', 1]] as const) {
      const { relay, harmony, matrix } = setup({ pairs, extra: { avatarScope: scope } })
      harmony.bridgeRoom.mockImplementation(async (id: string) => ({ room_id: id === channelId ? roomId : '!other:matrix.test', sender_mode: 'relay' }))
      matrix.roomMember.mockResolvedValue({ avatar_mxc: 'mxc://matrix.test/a' })
      relay.acceptTransaction('one', [event(), event({ event_id: '$two', room_id: '!other:matrix.test' })])
      await relay.tick(); await relay.tick()
      expect(harmony.uploadBridgeAvatar).toHaveBeenCalledTimes(copies)
      expect(harmony.sendMessage.mock.calls.every(call => call[2].bridge_author.avatar_url)).toBe(true)
      relay.forgetChannel(otherChannel)
      relay.acceptTransaction('again', [event({ event_id: '$three' })])
      await relay.tick()
      expect(harmony.uploadBridgeAvatar).toHaveBeenCalledTimes(copies + 1)
    }
  })
  it('does not copy a failing avatar again for ten minutes', async () => {
    vi.useFakeTimers()
    const { relay, matrix, harmony } = setup()
    matrix.roomMember.mockResolvedValue({ avatar_mxc: 'mxc://matrix.test/a' })
    harmony.uploadBridgeAvatar.mockRejectedValue(new HttpError('full', false, 507))
    for (const id of ['$a', '$b']) { relay.acceptTransaction(id, [event({ event_id: id })]); await relay.tick() }
    expect(matrix.avatarThumbnail).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(10 * 60_000)
    relay.acceptTransaction('c', [event({ event_id: '$c' })])
    await relay.tick()
    expect(matrix.avatarThumbnail).toHaveBeenCalledTimes(2)
    expect(harmony.sendMessage).toHaveBeenCalledTimes(3)
  })
  it('lists the first 1000 of a large room without copying avatars, and asks seldom', async () => {
    vi.useFakeTimers()
    const { relay, matrix, harmony } = setup()
    matrix.roomMembers.mockResolvedValue(Array.from({ length: 1500 }, (_, index) => ({ id: `@p${index}:matrix.test`, avatar_mxc: 'mxc://matrix.test/a' })))
    relay.requestMemberSync()
    await relay.tick()
    expect(harmony.publishMatrixMembers.mock.calls[0][1]).toHaveLength(1000)
    expect(matrix.avatarThumbnail).not.toHaveBeenCalled()
    vi.advanceTimersByTime(9 * 60_000)
    await relay.tick()
    expect(matrix.roomMembers).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(60_000)
    await relay.tick()
    expect(matrix.roomMembers).toHaveBeenCalledTimes(2)
  })
  it('delivers messages that mention someone in a room too large to list', async () => {
    vi.useFakeTimers()
    const { relay, matrix, reports } = setup()
    matrix.roomMembers.mockRejectedValue(new ResponseTooLarge())
    relay.requestMemberSync()
    relay.acceptHarmonyMessage(message({ content_raw: [{ type: 'mention', userId: alice, username: 'alice', isBridged: true, bridgeSource: 'matrix' }] }))
    await relay.tick()
    expect(matrix.sendMessage.mock.calls[0][3].userIds).toEqual([alice])
    expect(matrix.roomMember).toHaveBeenCalledWith(roomId, alice)
    expect(reports).toEqual([])
    vi.advanceTimersByTime(60_000)
    await relay.tick()
    expect(matrix.roomMembers).toHaveBeenCalledOnce()
  })
  it('copies a small room\'s avatars a few at a time', async () => {
    const { relay, matrix, harmony } = setup()
    matrix.roomMembers.mockResolvedValue(Array.from({ length: 25 }, (_, index) => ({ id: `@p${index}:matrix.test`, avatar_mxc: `mxc://matrix.test/a${index}` })))
    relay.requestMemberSync()
    await relay.tick()
    expect(matrix.avatarThumbnail).toHaveBeenCalledTimes(10)
    await relay.tick(); await relay.tick(); await relay.tick()
    expect(matrix.avatarThumbnail).toHaveBeenCalledTimes(25)
    expect(harmony.publishMatrixMembers.mock.calls.at(-1)![1].every((member: { avatarUrl: string | null }) => member.avatarUrl)).toBe(true)
  })
  it('reads no member list for a reply that names only Matrix people', async () => {
    const { relay, harmony } = setup()
    relay.acceptTransaction('one', [say('hi', '$one', { 'm.mentions': { user_ids: ['@bob:matrix.test'] } })])
    await relay.tick()
    expect(harmony.bridgeMembers).not.toHaveBeenCalled()
    expect(harmony.sendMessage.mock.calls[0][1]).toEqual([{ type: 'text', text: 'hi' }])
  })
})

describe('a fence', () => {
  it('is told once it is stored, from a transaction or a sync', () => {
    for (const path of ['transaction', 'sync'] as const) {
      const told: boolean[] = []
      const { relay, store } = setup({ extra: { onEncrypted: room => told.push(store.isRoomBlocked(room)) } })
      const fence = { type: 'm.room.encryption', room_id: roomId }
      if (path === 'transaction') relay.acceptTransaction('one', [fence, { ...fence, room_id: '!unpaired:test' }])
      else relay.acceptSync('@me:test', { nextBatch: 's', rooms: [roomId], events: [], history: [fence] })
      expect(told).toEqual([true])
    }
  })
})

describe('the bridge\'s own membership', () => {
  it('keeps invites for the room list and reports removals', () => {
    const onMembership = vi.fn()
    const { relay, store } = setup({ pairs: [], extra: { onMembership } })
    const state = [{ type: 'm.room.name', state_key: '', content: { name: 'Town‮ square\n' } }, { type: 'm.room.canonical_alias', content: { alias: '#town:matrix.test' } }]
    const member = (membership: string, extra: Record<string, unknown> = {}) => ({ type: 'm.room.member', room_id: '!town:matrix.test', state_key: bot, sender: alice, content: { membership }, ...extra })
    relay.acceptTransaction('invite', [member('invite', { unsigned: { invite_room_state: state } }), { ...member('invite'), room_id: '!else:matrix.test', state_key: alice }])
    expect(store.invites()).toEqual([{ roomId: '!town:matrix.test', name: 'Town square', alias: '#town:matrix.test', encrypted: false }])
    relay.acceptTransaction('encrypted', [member('invite', { unsigned: { invite_room_state: [...state, { type: 'm.room.encryption', content: {} }] } })])
    expect(store.invites()[0].encrypted).toBe(true)
    relay.acceptTransaction('leave', [member('leave')])
    expect(store.invites()).toEqual([])
    expect(onMembership.mock.calls).toEqual([['!town:matrix.test', 'invite'], ['!town:matrix.test', 'invite'], ['!town:matrix.test', 'leave']])
  })
})
