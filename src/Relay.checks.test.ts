import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LivePair, MatrixIdentity } from './config.js'
import { ghostUserId } from './config.js'
import { GhostRegistry } from './Ghosts.js'
import type { BridgeCheck, BridgeMember } from './HarmonyClient.js'
import { HttpError } from './http.js'
import { PrivacyDesk, type PrivacyApi } from './Privacy.js'
import { Relay, type MatrixEvent, type RelayOptions } from './Relay.js'
import { Store } from './Store.js'

const channelId = '22222222-2222-4222-8222-222222222222'
const userId = '11111111-1111-4111-8111-111111111111'
const roomId = '!test:matrix.test'
const alice = '@alice:matrix.test'
const stores: Store[] = []
const relays: Relay[] = []
afterEach(async () => { vi.useRealTimers(); for (const relay of relays.splice(0)) await relay.stop(); stores.splice(0).forEach(store => store.close()) })

const pairOf = (index: number): LivePair => ({ harmonyChannelId: index ? `22222222-2222-4222-8222-${String(index).padStart(12, '0')}` : channelId,
  matrixRoomId: index ? `!room${index}:matrix.test` : roomId, direction: 'both', senderMode: 'ghost' })
const member: BridgeMember = { id: userId, username: 'alice', display_name: 'Alice', avatar_url: null, domain: 'harmony.test' }

function setup(options: { mode?: 'ghost' | 'relay'; pairs?: number; identity?: MatrixIdentity; extra?: RelayOptions; store?: Store; registry?: GhostRegistry } = {}) {
  const settings = { pairs: Array.from({ length: options.pairs ?? 1 }, (_, index) => pairOf(index)), harmony: {}, matrix: options.identity ?? { serverName: 'matrix.test', senderLocalpart: 'harmony_relay' } as MatrixIdentity }
  const store = options.store ?? new Store(':memory:')
  if (!stores.includes(store)) stores.push(store)
  const fresh = (channel: string, id?: string): BridgeCheck => ({ registered: true, roomId: settings.pairs.find(pair => pair.harmonyChannelId === channel)?.matrixRoomId ?? null, mode: options.mode ?? 'ghost',
    plaintext: true, relayAllowed: id !== undefined, member: id === userId ? member : null })
  const harmony = { check: vi.fn(async (channel: string, id?: string) => fresh(channel, id)), sendMessage: vi.fn().mockResolvedValue({ id: 'h-copy' }), canReplyTo: vi.fn().mockResolvedValue(true),
    uploadBridgeAvatar: vi.fn().mockResolvedValue('https://storage.test/avatar.png'), bridgeMembers: vi.fn().mockResolvedValue([member]),
    nativeAvatar: vi.fn().mockResolvedValue({ data: 'aW1hZ2U=', content_type: 'image/png' }), publishMatrixMembers: vi.fn(),
    downloadFile: vi.fn().mockResolvedValue({ bytes: Buffer.from('bytes'), name: 'a.txt', contentType: 'text/plain' }), uploadFile: vi.fn().mockResolvedValue({ type: 'file', path: 'c/x' }) }
  const matrix = { sendMessage: vi.fn().mockResolvedValue({ event_id: '$m-copy' }), roomIsPlaintext: vi.fn().mockResolvedValue(true),
    roomMember: vi.fn().mockResolvedValue({ display_name: 'Room Alice' }), avatarThumbnail: vi.fn().mockResolvedValue({ data: 'aW1hZ2U=', content_type: 'image/png' }),
    registerGhost: vi.fn().mockResolvedValue(undefined), joinGhost: vi.fn().mockResolvedValue(undefined), leaveGhost: vi.fn().mockResolvedValue(undefined),
    uploadAvatar: vi.fn().mockResolvedValue('mxc://matrix.test/native'), roomMembers: vi.fn().mockResolvedValue([{ id: alice }]),
    downloadFile: vi.fn().mockResolvedValue({ bytes: Buffer.from('bytes'), name: 'a.txt', contentType: 'text/plain' }),
    uploadFile: vi.fn().mockResolvedValue('mxc://matrix.test/uploaded'), sendFile: vi.fn().mockResolvedValue({ event_id: '$file-copy' }) }
  const api = { optOuts: vi.fn(), optOut: vi.fn(), setOptOut: vi.fn().mockResolvedValue({ optedOut: true, source: 'user' }), erase: vi.fn() }
  const privacy = new PrivacyDesk(api as unknown as PrivacyApi, { oneServer: true })
  const relay = new Relay(settings, store, harmony, matrix, () => {}, { privacy, ghosts: options.registry, ...options.extra })
  relays.push(relay)
  const ghost = options.identity?.userId ? '' : ghostUserId(settings, userId)
  return { settings, store, harmony, matrix, api, privacy, relay, fresh, ghost,
    native: (id = 'h-one', channel = 0, extra: Record<string, unknown> = {}) => relay.acceptHarmonyMessage({ id, channel_id: settings.pairs[channel].harmonyChannelId, author: { id: userId, username: 'alice' }, content: id, metadata: {}, ...extra }),
    incoming: (id = '$one', channel = 0, extra: Partial<MatrixEvent> = {}) => relay.acceptTransaction(id, [{ type: 'm.room.message', event_id: id, room_id: settings.pairs[channel].matrixRoomId, sender: alice, content: { msgtype: 'm.text', body: id }, ...extra }]) }
}
type World = ReturnType<typeof setup>

/** What may change while a message is on its way, and how the bridge learns of it. */
const harmonyChanges: Array<[string, (check: BridgeCheck) => BridgeCheck]> = [
  ['the binding is gone', () => ({ registered: false, roomId: null, mode: null, plaintext: false, relayAllowed: false, member: null })],
  ['another room is bound', check => ({ ...check, roomId: '!else:matrix.test' })],
  ['no room is bound', check => ({ ...check, roomId: null })],
  ['the channel is encrypted', check => ({ ...check, plaintext: false })],
]
const memberChanges: Array<[string, (check: BridgeCheck) => BridgeCheck]> = [
  ['the member opted out', check => ({ ...check, relayAllowed: false })],
  ['the member left or lost sight of the channel', check => ({ ...check, member: null })],
  ['the sender mode changed', check => ({ ...check, mode: check.mode === 'ghost' ? 'relay' : 'ghost' })],
]
const localChanges: Array<[string, (world: World) => void]> = [
  ['the room fence', world => { world.store.acceptTransaction('fence', [], [roomId]) }],
  ['the pair is removed', world => { world.settings.pairs = [] }],
  ['the pair is in error', world => { world.settings.pairs = [{ ...pairOf(0), state: 'error' }] }],
  ['the pair\'s direction', world => { world.settings.pairs = [{ ...pairOf(0), direction: 'to_harmony' }] }],
  ['the list', world => { Object.assign(world.settings.harmony, { allowedUserIds: [] }) }],
]
/** The second and later checks answer `change` of what the first did. */
function changeAfterFirst(world: World, change: (check: BridgeCheck) => BridgeCheck) {
  let calls = 0
  world.harmony.check.mockImplementation(async (channel: string, id?: string) => calls++ ? change(world.fresh(channel, id)) : world.fresh(channel, id))
}

describe('a change between the two checks stops a message', () => {
  it.each([...harmonyChanges, ...memberChanges])('to Matrix through a known ghost: %s', async (_name, change) => {
    const world = setup()
    world.native('first')
    await world.relay.tick()
    expect(world.matrix.sendMessage).toHaveBeenCalledOnce()
    changeAfterFirst(world, change)
    world.harmony.check.mockClear()
    world.native('second')
    await world.relay.tick()
    expect(world.harmony.check).toHaveBeenCalledTimes(2)
    expect(world.matrix.sendMessage).toHaveBeenCalledOnce()
    expect(world.store.counts()).toEqual({ pending: 0, failed: 1 })
  })
  it.each([...harmonyChanges, memberChanges[0], memberChanges[2]])('to Matrix through the single sender: %s', async (_name, change) => {
    const world = setup({ mode: 'relay' })
    changeAfterFirst(world, change)
    world.native()
    await world.relay.tick()
    expect(world.matrix.sendMessage).not.toHaveBeenCalled()
    expect(world.store.counts()).toEqual({ pending: 0, failed: 1 })
  })
  it.each(harmonyChanges)('to Harmony: %s', async (_name, change) => {
    const world = setup()
    changeAfterFirst(world, change)
    world.incoming()
    await world.relay.tick()
    expect(world.harmony.check).toHaveBeenCalledTimes(2)
    expect(world.harmony.sendMessage).not.toHaveBeenCalled()
    expect(world.store.counts()).toEqual({ pending: 0, failed: 1 })
  })
  it.each(['to_matrix', 'to_harmony'])('%s: the room is encrypted', async direction => {
    const world = setup()
    if (direction === 'to_matrix') { world.native('known'); await world.relay.tick(); world.matrix.sendMessage.mockClear() }
    world.matrix.roomIsPlaintext.mockClear()
    world.matrix.roomIsPlaintext.mockResolvedValueOnce(true).mockResolvedValue(false)
    if (direction === 'to_matrix') world.native(); else world.incoming()
    await world.relay.tick()
    expect(world.matrix.roomIsPlaintext).toHaveBeenCalledTimes(2)
    expect(world.matrix.sendMessage).not.toHaveBeenCalled()
    expect(world.harmony.sendMessage).not.toHaveBeenCalled()
    expect(world.store.counts().failed).toBe(1)
  })
  it.each(localChanges)('to Matrix, known here during the very last request: %s', async (_name, change) => {
    const world = setup({ mode: 'relay' })
    let reads = 0
    world.matrix.roomIsPlaintext.mockImplementation(async () => { if (++reads === 2) change(world); return true })
    world.native()
    await world.relay.tick()
    expect(reads).toBe(2)
    expect(world.matrix.sendMessage).not.toHaveBeenCalled()
    expect(world.store.counts()).toEqual({ pending: 0, failed: 1 })
  })
  it.each<[string, (world: World) => void]>([localChanges[0], localChanges[1], localChanges[2], ['the pair\'s direction', world => { world.settings.pairs = [{ ...pairOf(0), direction: 'to_matrix' }] }],
    ['the author opted out', world => { world.privacy.noteOptedOut(channelId, alice) }], ['the list', world => { Object.assign(world.settings.matrix, { allowedUserIds: [] }) }]])('to Harmony, known here during the very last request: %s', async (_name, change) => {
    const world = setup()
    let checks = 0
    world.harmony.check.mockImplementation(async (channel: string) => { if (++checks === 2) change(world); return { ...world.fresh(channel), roomId } })
    world.incoming()
    await world.relay.tick()
    expect(checks).toBe(2)
    expect(world.harmony.sendMessage).not.toHaveBeenCalled()
    expect(world.store.counts()).toEqual({ pending: 0, failed: 1 })
  })
  it.each([...harmonyChanges, memberChanges[0], memberChanges[2]])('a file to Matrix, before the upload: %s', async (_name, change) => {
    const world = setup({ mode: 'relay' })
    let changed = false
    world.harmony.check.mockImplementation(async (channel: string, id?: string) => changed ? change(world.fresh(channel, id)) : world.fresh(channel, id))
    world.harmony.downloadFile.mockImplementation(async () => { changed = true; return { bytes: Buffer.from('x'), name: 'a.txt', contentType: 'text/plain' } })
    world.native('h', 0, { content_raw: [{ type: 'file', fileName: 'a.txt' }] })
    await world.relay.tick()
    expect(world.matrix.uploadFile).not.toHaveBeenCalled()
    expect(world.matrix.sendFile).not.toHaveBeenCalled()
    expect(world.matrix.sendMessage.mock.calls.filter(call => String(call[2]).includes('unavailable'))).toEqual([])
    expect(world.store.counts().failed).toBe(1)
  })
  it.each([...harmonyChanges, memberChanges[0], memberChanges[2]])('a file to Matrix, between the upload and its event: %s', async (_name, change) => {
    const world = setup({ mode: 'relay' })
    let changed = false
    world.harmony.check.mockImplementation(async (channel: string, id?: string) => changed ? change(world.fresh(channel, id)) : world.fresh(channel, id))
    world.matrix.uploadFile.mockImplementation(async () => { changed = true; return 'mxc://matrix.test/uploaded' })
    world.native('h', 0, { content_raw: [{ type: 'file', fileName: 'a.txt' }] })
    await world.relay.tick()
    expect(world.matrix.sendFile).not.toHaveBeenCalled()
    expect(world.matrix.sendMessage.mock.calls.filter(call => String(call[2]).includes('unavailable'))).toEqual([])
    expect(world.store.counts().failed).toBe(1)
  })
  it.each([...harmonyChanges, memberChanges[0], memberChanges[2]])('the notice of a file that cannot be copied: %s', async (_name, change) => {
    const world = setup({ mode: 'relay' })
    let changed = false
    world.harmony.check.mockImplementation(async (channel: string, id?: string) => changed ? change(world.fresh(channel, id)) : world.fresh(channel, id))
    world.matrix.sendMessage.mockImplementation(async () => { changed = true; return { event_id: '$m-copy' } })
    world.native('text', 0, { content_raw: [{ type: 'text', text: 'text' }, { type: 'file', fileName: 'a.txt', fileSize: 10 ** 12 }] })
    await world.relay.tick()
    expect(world.matrix.sendMessage).toHaveBeenCalledOnce()
    expect(world.store.counts().failed).toBe(1)
  })
  it.each(harmonyChanges)('a file to Harmony, between the upload and its message: %s', async (_name, change) => {
    const world = setup()
    let changed = false
    world.harmony.check.mockImplementation(async (channel: string, id?: string) => changed ? change(world.fresh(channel, id)) : world.fresh(channel, id))
    world.harmony.uploadFile.mockImplementation(async () => { changed = true; return { type: 'file', path: 'c/x' } })
    world.incoming('$file', 0, { content: { msgtype: 'm.file', body: 'a.txt', filename: 'a.txt', url: 'mxc://matrix.test/a' } })
    await world.relay.tick()
    expect(world.harmony.uploadFile).toHaveBeenCalledOnce()
    expect(world.harmony.sendMessage).not.toHaveBeenCalled()
    expect(world.store.counts().failed).toBe(1)
  })
  it.each([...harmonyChanges, memberChanges[0], memberChanges[1], memberChanges[2]])('a ghost before it is registered, named or joined: %s', async (_name, change) => {
    for (const at of ['before registering', 'before the avatar', 'before joining'] as const) {
      const world = setup()
      const picture = { ...member, avatar_url: 'https://harmony.test/a.png' }
      let changed = false
      world.harmony.check.mockImplementation(async (channel: string, id?: string) => {
        const check = { ...world.fresh(channel, id), member: picture }
        return changed ? change(check) : check
      })
      if (at === 'before registering') world.matrix.roomIsPlaintext.mockImplementationOnce(async () => { changed = true; return true })
      if (at === 'before the avatar') world.harmony.nativeAvatar.mockImplementation(async () => { changed = true; return { data: 'aW1hZ2U=', content_type: 'image/png' } })
      if (at === 'before joining') world.matrix.uploadAvatar.mockImplementation(async () => { changed = true; return 'mxc://matrix.test/native' })
      world.native()
      await world.relay.tick()
      expect(world.matrix.registerGhost, at).toHaveBeenCalledTimes(at === 'before registering' ? 0 : 1)
      expect(world.matrix.uploadAvatar, at).toHaveBeenCalledTimes(at === 'before joining' ? 1 : 0)
      expect(world.matrix.joinGhost, at).not.toHaveBeenCalled()
      expect(world.matrix.sendMessage, at).not.toHaveBeenCalled()
    }
  })
  it.each(harmonyChanges)('the answer to a privacy command, not the choice: %s', async (_name, change) => {
    const world = setup()
    changeAfterFirst(world, change)
    world.incoming('$ask', 0, { content: { msgtype: 'm.text', body: '!bridge-privacy opt-out' } })
    await world.relay.tick()
    expect(world.api.setOptOut).toHaveBeenCalledOnce()
    expect(world.matrix.sendMessage).not.toHaveBeenCalled()
  })
  it.each(localChanges.slice(0, 3))('the answer to a privacy command, known here during the last request: %s', async (_name, change) => {
    const world = setup()
    world.matrix.roomIsPlaintext.mockImplementation(async () => { change(world); return true })
    world.incoming('$ask', 0, { content: { msgtype: 'm.text', body: '!bridge-privacy opt-out' } })
    await world.relay.tick()
    expect(world.matrix.sendMessage).not.toHaveBeenCalled()
  })
  it('a privacy command of a channel that is not this bridge\'s changes no choice', async () => {
    const world = setup()
    world.harmony.check.mockResolvedValue({ registered: false, roomId: null, mode: null, plaintext: false, relayAllowed: false, member: null })
    world.incoming('$ask', 0, { content: { msgtype: 'm.text', body: '!bridge-privacy opt-out' } })
    await world.relay.tick()
    expect(world.api.setOptOut).not.toHaveBeenCalled()
    expect(world.store.counts().failed).toBe(1)
  })
  it('reads an unclear or failed check as no permission', async () => {
    for (const [answer, failed] of [[new HttpError('Invalid bridge check', false), 1], [new HttpError('down', true, 503), 0]] as const) {
      for (const direction of ['to_matrix', 'to_harmony']) {
        const world = setup({ mode: 'relay' })
        let calls = 0
        world.harmony.check.mockImplementation(async (channel: string, id?: string) => { if (calls++) throw answer; return world.fresh(channel, id) })
        if (direction === 'to_matrix') world.native(); else world.incoming()
        await world.relay.tick()
        expect(world.matrix.sendMessage).not.toHaveBeenCalled()
        expect(world.harmony.sendMessage).not.toHaveBeenCalled()
        expect(world.store.counts()).toEqual({ pending: 1 - failed, failed })
      }
    }
  })
})

describe('rooms another bridge on the connection owns by now', () => {
  it('keep their ghosts', async () => {
    let owned = false
    const world = setup({ extra: { ownsRoom: () => owned } })
    world.native()
    await world.relay.tick()
    expect(world.matrix.joinGhost).toHaveBeenCalledOnce()
    world.harmony.check.mockImplementation(async (channel: string, id?: string) => ({ ...world.fresh(channel, id), roomId: null }))
    world.relay.requestMemberSync()
    await world.relay.tick()
    expect(world.matrix.leaveGhost).not.toHaveBeenCalled()
    owned = true
    world.relay.requestMemberSync()
    await world.relay.tick()
    expect(world.matrix.leaveGhost).toHaveBeenCalledExactlyOnceWith(roomId, world.ghost)
  })
})

describe('a known ghost', () => {
  it('is not joined again while its profile is the one in the room, across restarts', async () => {
    const world = setup()
    for (const id of ['a', 'b', 'c']) { world.native(id); await world.relay.tick() }
    expect(world.matrix.joinGhost).toHaveBeenCalledOnce()
    expect(world.matrix.registerGhost).toHaveBeenCalledOnce()
    const again = setup({ store: world.store })
    again.native('d')
    await again.relay.tick()
    expect(again.matrix.joinGhost).not.toHaveBeenCalled()
    expect(again.matrix.sendMessage.mock.calls[0][3].sender).toBe(world.ghost)
  })
  it('is shown anew when the member\'s name or picture changed', async () => {
    const world = setup()
    world.native('a')
    await world.relay.tick()
    for (const change of [{ display_name: 'New name' }, { display_name: 'New name', avatar_url: 'https://harmony.test/b.png' }]) {
      world.harmony.check.mockImplementation(async (channel: string, id?: string) => ({ ...world.fresh(channel, id), member: { ...member, ...change } }))
      world.native(JSON.stringify(change))
      await world.relay.tick()
    }
    expect(world.matrix.joinGhost).toHaveBeenCalledTimes(3)
    expect(world.matrix.joinGhost.mock.calls[2][2]).toEqual({ displayname: 'New name', avatar_url: 'mxc://matrix.test/native' })
  })
  it('that was removed is prepared once when its message is refused, under new checks, and the message goes', async () => {
    const world = setup()
    world.native('a')
    await world.relay.tick()
    world.matrix.sendMessage.mockClear()
    world.harmony.check.mockClear()
    world.matrix.sendMessage.mockRejectedValueOnce(new HttpError('not in room', false, 403, 'M_FORBIDDEN'))
    world.native('b')
    await world.relay.tick()
    expect(world.matrix.joinGhost).toHaveBeenCalledTimes(2)
    expect(world.matrix.sendMessage).toHaveBeenCalledTimes(2)
    expect(world.matrix.sendMessage.mock.calls[0][1]).toBe(world.matrix.sendMessage.mock.calls[1][1])
    expect(world.store.counts()).toEqual({ pending: 0, failed: 0 })
    expect(world.harmony.check.mock.calls.length).toBe(2 + 2 + 1)
  })
  it('is prepared once for a message of several pieces', async () => {
    const world = setup()
    world.native('a')
    await world.relay.tick()
    const gone = new HttpError('not in room', false, 403, 'M_FORBIDDEN')
    world.matrix.sendMessage.mockRejectedValueOnce(gone)
    world.matrix.sendFile.mockRejectedValue(gone)
    world.native('b', 0, { content_raw: [{ type: 'text', text: 'b' }, { type: 'file', fileName: 'a.txt' }] })
    await world.relay.tick()
    expect(world.matrix.joinGhost).toHaveBeenCalledTimes(2)
    expect(world.matrix.sendFile).toHaveBeenCalledOnce()
  })
  it('is prepared no second time, and not at all once consent is gone', async () => {
    const world = setup()
    world.native('a')
    await world.relay.tick()
    world.matrix.sendMessage.mockRejectedValue(new HttpError('not in room', false, 403, 'M_FORBIDDEN'))
    world.native('b')
    await world.relay.tick()
    expect(world.matrix.joinGhost).toHaveBeenCalledTimes(2)
    expect(world.store.counts().failed).toBe(1)
    world.matrix.sendMessage.mockClear()
    world.matrix.sendMessage.mockImplementationOnce(async () => {
      world.harmony.check.mockImplementation(async (channel: string, id?: string) => ({ ...world.fresh(channel, id), relayAllowed: false }))
      throw new HttpError('not in room', false, 403, 'M_FORBIDDEN')
    })
    world.native('c')
    await world.relay.tick()
    expect(world.matrix.sendMessage).toHaveBeenCalledOnce()
    expect(world.matrix.joinGhost).toHaveBeenCalledTimes(2)
  })
  it('is prepared again after the homeserver told that it left', async () => {
    const world = setup()
    world.native('a')
    await world.relay.tick()
    for (const [membership, joins] of [['join', 1], ['invite', 1], ['ban', 2], ['leave', 3]] as const) {
      world.relay.acceptTransaction(membership, [{ type: 'm.room.member', event_id: `$${membership}`, room_id: roomId, state_key: world.ghost, sender: alice, content: { membership } }])
      world.native(membership)
      await world.relay.tick()
      expect(world.matrix.joinGhost, membership).toHaveBeenCalledTimes(joins)
    }
  })
  it('is registered once when two rooms, or two bridges on one connection, need it at the same time', async () => {
    const world = setup({ pairs: 2 })
    let registered!: () => void
    world.matrix.registerGhost.mockImplementation(() => new Promise<void>(resolve => { registered = resolve }))
    const registry = new GhostRegistry(world.store, world.matrix)
    const both = [registry.register(world.ghost, userId), registry.register(world.ghost, userId)]
    registered()
    await Promise.all(both)
    await registry.register(world.ghost, userId)
    expect(world.matrix.registerGhost).toHaveBeenCalledExactlyOnceWith(world.ghost, false)
    world.matrix.registerGhost.mockClear()
    const other = setup({ registry })
    other.native()
    await other.relay.tick()
    expect(world.matrix.registerGhost).not.toHaveBeenCalled()
    expect(other.matrix.sendMessage.mock.calls[0][3].sender).toBe(world.ghost)
  })
})

describe('delivery', () => {
  const settle = async () => { for (let round = 0; round < 50; round++) await Promise.resolve() }
  it('goes on without a tick, in order within a channel', async () => {
    const world = setup({ mode: 'relay' })
    world.relay.start()
    for (let index = 0; index < 20; index++) world.native(`n${index}`)
    await vi.waitFor(() => expect(world.matrix.sendMessage).toHaveBeenCalledTimes(20))
    expect(world.matrix.sendMessage.mock.calls.map(call => call[2])).toEqual(Array.from({ length: 20 }, (_, index) => `[alice · Harmony] n${index}`))
  })
  it('keeps the order of a channel through a retry, while others go on', async () => {
    vi.useFakeTimers()
    const world = setup({ mode: 'relay', pairs: 2 })
    world.relay.start()
    world.matrix.sendMessage.mockRejectedValueOnce(new HttpError('busy', true, 503))
    world.native('a1')
    world.native('a2')
    world.native('b1', 1)
    await vi.advanceTimersByTimeAsync(500)
    const bodies = () => world.matrix.sendMessage.mock.calls.map(call => String(call[2]).slice(-2))
    expect(bodies()).toEqual(['a1', 'b1'])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(bodies()).toEqual(['a1', 'b1', 'a1', 'a2'])
  })
  it('works on four channels at once, and one message of each', async () => {
    const world = setup({ mode: 'relay', pairs: 6 })
    const waiting: Array<() => void> = []
    world.matrix.sendMessage.mockImplementation(() => new Promise(resolve => { waiting.push(() => resolve({ event_id: '$x' })) }))
    world.relay.start()
    for (let channel = 0; channel < 6; channel++) for (const part of ['first', 'second']) world.native(`${channel}-${part}`, channel)
    await vi.waitFor(() => expect(waiting).toHaveLength(4))
    await settle()
    expect(waiting).toHaveLength(4)
    const rooms = world.matrix.sendMessage.mock.calls.map(call => call[0])
    expect(new Set(rooms).size).toBe(4)
    waiting.shift()!()
    await vi.waitFor(() => expect(waiting).toHaveLength(4))
    while (world.store.counts().pending) { waiting.shift()?.(); await new Promise(resolve => setTimeout(resolve, 1)) }
    const order = world.matrix.sendMessage.mock.calls.map(call => String(call[2]))
    for (let channel = 0; channel < 6; channel++) expect(order.findIndex(body => body.endsWith(`${channel}-first`))).toBeLessThan(order.findIndex(body => body.endsWith(`${channel}-second`)))
  })
  it('lets one channel\'s two directions pass each other, and a homeserver that hangs hold up nothing but its lane', async () => {
    const world = setup({ mode: 'relay' })
    world.matrix.sendMessage.mockImplementation(() => new Promise(() => {}))
    world.relay.start()
    world.native('stuck')
    world.native('behind')
    world.incoming('$through')
    await vi.waitFor(() => expect(world.harmony.sendMessage).toHaveBeenCalledOnce())
    expect(world.matrix.sendMessage).toHaveBeenCalledOnce()
    relays.splice(0)
  })
  it('wakes for a pair that becomes ready and for a job whose delay ends', async () => {
    vi.useFakeTimers()
    const world = setup({ mode: 'relay' })
    world.settings.pairs = [{ ...pairOf(0), state: 'joining' }]
    world.relay.start()
    world.native('waits')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(world.matrix.sendMessage).not.toHaveBeenCalled()
    world.settings.pairs = [{ ...pairOf(0), state: 'ready' }]
    world.relay.wake()
    await vi.advanceTimersByTimeAsync(0)
    expect(world.matrix.sendMessage).toHaveBeenCalledOnce()
    world.matrix.sendMessage.mockRejectedValueOnce(new HttpError('limited', true, 429, 'M_LIMIT_EXCEEDED', 7_000))
    world.native('limited')
    await vi.advanceTimersByTimeAsync(6_999)
    expect(world.matrix.sendMessage).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(world.matrix.sendMessage).toHaveBeenCalledTimes(3)
  })
  it('begins no message to a room whose ghosts are being refreshed', async () => {
    const world = setup()
    let finish!: () => void
    world.harmony.bridgeMembers.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve([]) }))
    world.relay.start()
    world.relay.requestMemberSync()
    await vi.waitFor(() => expect(world.harmony.bridgeMembers).toHaveBeenCalledOnce())
    world.native('waits')
    world.incoming('$passes')
    await vi.waitFor(() => expect(world.harmony.sendMessage).toHaveBeenCalledOnce())
    expect(world.matrix.sendMessage).not.toHaveBeenCalled()
    finish()
    await vi.waitFor(() => expect(world.matrix.sendMessage).toHaveBeenCalledOnce())
  })
  it('does not refresh a room\'s ghosts while a message goes to it, nor begin one while a refresh waits', async () => {
    const world = setup()
    world.native('known')
    await world.relay.tick()
    let finish!: () => void
    world.matrix.sendMessage.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ event_id: '$x' }) }))
    world.matrix.sendMessage.mockClear()
    world.relay.start()
    world.native('slow')
    await vi.waitFor(() => expect(world.matrix.sendMessage).toHaveBeenCalledOnce())
    world.native('after')
    world.relay.requestMemberSync()
    await settle()
    expect(world.harmony.bridgeMembers).not.toHaveBeenCalled()
    finish()
    await vi.waitFor(() => expect(world.matrix.sendMessage).toHaveBeenCalledTimes(2))
    expect(world.harmony.bridgeMembers.mock.invocationCallOrder[0]).toBeLessThan(world.matrix.sendMessage.mock.invocationCallOrder[1])
  })
  it('stops with its jobs intact when storage fails under way, and waits for what is under way when stopped', async () => {
    const world = setup({ mode: 'relay', pairs: 2 })
    let finish!: () => void
    world.matrix.sendMessage.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ event_id: '$x' }) }))
    world.relay.start()
    world.native('slow')
    await vi.waitFor(() => expect(world.matrix.sendMessage).toHaveBeenCalledOnce())
    vi.spyOn(world.store, 'freezeSender').mockImplementation(() => { throw new (Object.getPrototypeOf(class extends Error {}))('disk') })
    const stopped = vi.fn()
    const stopping = world.relay.stop().then(stopped)
    await settle()
    expect(stopped).not.toHaveBeenCalled()
    finish()
    await stopping
    expect(world.store.counts()).toEqual({ pending: 0, failed: 0 })
    const broken = setup({ mode: 'relay', pairs: 2 })
    vi.spyOn(broken.store, 'complete').mockImplementation(() => { throw new Error('disk') })
    broken.relay.start()
    broken.native('a')
    await vi.waitFor(() => expect(broken.relay.isHealthy).toBe(false))
    broken.store.enqueue({ direction: 'to_matrix', sourceId: 'later', channelId, roomId, payload: {} })
    await settle()
    expect(broken.store.counts().pending).toBe(2)
  })
})

describe('refreshes', () => {
  const membership = (id: string, key: string) => [{ type: 'm.room.member', event_id: id, room_id: roomId, state_key: key, sender: key, content: { membership: 'join' } }]
  async function started(options: Parameters<typeof setup>[0] = {}) {
    vi.useFakeTimers()
    const world = setup(options)
    world.relay.start()
    world.relay.requestMemberSync()
    await vi.advanceTimersByTimeAsync(100)
    world.harmony.check.mockClear()
    world.harmony.bridgeMembers.mockClear()
    world.matrix.roomMembers.mockClear()
    return world
  }
  it('come every ten minutes by themselves', async () => {
    const world = await started()
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    expect(world.harmony.check).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(world.harmony.bridgeMembers).toHaveBeenCalledOnce()
    expect(world.matrix.roomMembers).toHaveBeenCalledOnce()
    expect(world.harmony.check).toHaveBeenCalledTimes(2)
  })
  it('gather a room\'s membership changes for half a minute, without asking for Harmony\'s members', async () => {
    const world = await started()
    for (let index = 0; index < 20; index++) {
      world.relay.acceptTransaction(`m${index}`, membership(`$m${index}`, `@p${index}:matrix.test`))
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(world.matrix.roomMembers).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(11_000)
    expect(world.matrix.roomMembers).toHaveBeenCalledOnce()
    expect(world.harmony.bridgeMembers).not.toHaveBeenCalled()
    expect(world.harmony.check).toHaveBeenCalledTimes(2)
    world.relay.acceptTransaction('ghost', membership('$ghost', world.ghost))
    world.relay.acceptTransaction('elsewhere', [{ ...membership('$else', alice)[0], room_id: '!unpaired:matrix.test' }])
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(world.matrix.roomMembers).toHaveBeenCalledOnce()
  })
  it('follow the configuration and its opt-outs, gathered', async () => {
    const world = await started({ pairs: 2 })
    for (let index = 0; index < 10; index++) { world.relay.noteConfiguration(); await vi.advanceTimersByTimeAsync(2_000) }
    expect(world.harmony.bridgeMembers).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(11_000)
    expect(world.harmony.bridgeMembers).toHaveBeenCalledTimes(2)
    expect(world.matrix.roomMembers).toHaveBeenCalledTimes(2)
  })
  it('list a large room no more often than every ten minutes, however busy', async () => {
    const world = await started()
    world.matrix.roomMembers.mockResolvedValue(Array.from({ length: 1500 }, (_, index) => ({ id: `@p${index}:matrix.test` })))
    world.relay.acceptTransaction('first', membership('$first', alice))
    await vi.advanceTimersByTimeAsync(31_000)
    expect(world.matrix.roomMembers).toHaveBeenCalledOnce()
    for (let minute = 0; minute < 9; minute++) { world.relay.acceptTransaction(`m${minute}`, membership(`$m${minute}`, alice)); await vi.advanceTimersByTimeAsync(60_000) }
    expect(world.matrix.roomMembers).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(world.matrix.roomMembers).toHaveBeenCalledTimes(2)
  })
  it('look at one member who left the server, only where their ghost is', async () => {
    const world = await started({ pairs: 3 })
    world.native('speaks')
    await vi.advanceTimersByTimeAsync(0)
    world.store.forgetGhostRoom('!room1:matrix.test', world.ghost)
    world.store.forgetGhostRoom('!room2:matrix.test', world.ghost)
    world.harmony.bridgeMembers.mockResolvedValue(Array.from({ length: 150 }, (_, index) => ({ ...member, id: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}` })))
    world.relay.requestMemberSync()
    await vi.advanceTimersByTimeAsync(100)
    world.store.trackGhostRoom(roomId, world.ghost)
    world.harmony.check.mockClear()
    world.harmony.bridgeMembers.mockClear()
    world.matrix.leaveGhost.mockClear()
    world.harmony.check.mockImplementation(async (channel: string, id?: string) => ({ ...world.fresh(channel, id), member: null }))
    world.relay.noteServerMember(userId)
    world.relay.noteServerMember(userId.toUpperCase())
    await vi.advanceTimersByTimeAsync(29_000)
    expect(world.harmony.check).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(world.harmony.check).toHaveBeenCalledExactlyOnceWith(channelId, userId)
    expect(world.matrix.leaveGhost).toHaveBeenCalledExactlyOnceWith(roomId, world.ghost)
    expect(world.harmony.bridgeMembers).not.toHaveBeenCalled()
  })
  it('prepare someone who joined a small server\'s channel, and leave a large one alone', async () => {
    const other = '44444444-4444-4444-8444-444444444444'
    for (const [size, joins] of [[2, 1], [100, 0]] as const) {
      const world = await started()
      world.harmony.bridgeMembers.mockResolvedValue(Array.from({ length: size }, (_, index) => ({ ...member, id: index ? `33333333-3333-4333-8333-${String(index).padStart(12, '0')}` : userId })))
      world.harmony.check.mockImplementation(async (channel: string, id?: string) => ({ ...world.fresh(channel, id), member: id ? { ...member, id } : null }))
      world.relay.requestMemberSync()
      await vi.advanceTimersByTimeAsync(1_000)
      const before = world.matrix.joinGhost.mock.calls.length
      world.harmony.check.mockClear()
      world.relay.noteServerMember(other)
      await vi.advanceTimersByTimeAsync(31_000)
      expect(world.matrix.joinGhost.mock.calls.length - before, String(size)).toBe(joins)
      expect(world.harmony.check.mock.calls.length > 0, String(size)).toBe(joins > 0)
    }
  })
  it('take a crowd of joins as one list, and ask nothing for the single sender or an ordinary account', async () => {
    const world = await started()
    for (let index = 0; index < 50; index++) world.relay.noteServerMember(`33333333-3333-4333-8333-${String(index).padStart(12, '0')}`)
    await vi.advanceTimersByTimeAsync(31_000)
    expect(world.harmony.bridgeMembers).toHaveBeenCalledOnce()
    expect(world.harmony.check).toHaveBeenCalledTimes(1)
    for (const options of [{ mode: 'relay' as const }, { identity: { serverName: 'matrix.test', userId: '@me:matrix.test' } }] as Array<Parameters<typeof setup>[0] & object>) {
      const quiet = await started(options)
      quiet.relay.noteServerMember(userId)
      await vi.advanceTimersByTimeAsync(31_000)
      expect(quiet.harmony.check).not.toHaveBeenCalled()
      if (!options.identity) continue
      for (let index = 0; index < 50; index++) quiet.relay.noteServerMember(`33333333-3333-4333-8333-${String(index).padStart(12, '0')}`)
      await vi.advanceTimersByTimeAsync(31_000)
      expect(quiet.harmony.check).not.toHaveBeenCalled()
    }
  })
  it('happen at once when they are asked for, and again for what changed meanwhile', async () => {
    const world = await started()
    world.relay.acceptTransaction('m', membership('$m', alice))
    world.matrix.roomMembers.mockImplementationOnce(async () => { world.relay.requestMemberSync(channelId); return [{ id: alice }] })
    world.relay.requestMemberSync(channelId)
    await vi.advanceTimersByTimeAsync(100)
    expect(world.matrix.roomMembers).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    expect(world.matrix.roomMembers).toHaveBeenCalledTimes(2)
  })
  it('that are refused empty the list, tell the pairs and wait a minute', async () => {
    const onRefused = vi.fn()
    const world = await started({ extra: { onRefused } })
    world.harmony.check.mockImplementation(async (channel: string, id?: string) => ({ ...world.fresh(channel, id), plaintext: false }))
    world.relay.requestMemberSync()
    await vi.advanceTimersByTimeAsync(100)
    expect(world.harmony.publishMatrixMembers).toHaveBeenLastCalledWith(channelId, [])
    expect(onRefused).toHaveBeenCalledExactlyOnceWith(channelId)
    expect(world.matrix.leaveGhost).toHaveBeenCalledExactlyOnceWith(roomId, world.ghost)
    await vi.advanceTimersByTimeAsync(59_000)
    expect(onRefused).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(onRefused).toHaveBeenCalledTimes(2)
    world.harmony.check.mockRejectedValue(new HttpError('down', true, 503))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onRefused).toHaveBeenCalledTimes(2)
  })
  it('do not publish a list that a later check refuses', async () => {
    const world = await started()
    world.harmony.publishMatrixMembers.mockClear()
    world.matrix.roomMembers.mockImplementation(async () => {
      world.harmony.check.mockImplementation(async (channel: string, id?: string) => ({ ...world.fresh(channel, id), plaintext: false }))
      return [{ id: alice }]
    })
    world.relay.requestMemberSync()
    await vi.advanceTimersByTimeAsync(100)
    expect(world.harmony.publishMatrixMembers.mock.calls).toEqual([[channelId, []]])
  })
})

describe('a command that links a room', () => {
  it('is relayed by no bridge, in neither direction', async () => {
    const world = setup({ mode: 'relay' })
    for (const body of ['!harmony link ML-AAAA-BBBB-CCCC', '!HARMONY  link x', '> <@a:x> y\n\n!harmony link ML-1']) {
      expect(world.native(body)).toBe(false)
      world.incoming(`$${body.length}`, 0, { content: { msgtype: 'm.text', body } })
      world.incoming(`$file${body.length}`, 0, { content: { msgtype: 'm.file', body, filename: 'a.txt', url: 'mxc://matrix.test/a' } })
    }
    expect(world.store.counts()).toEqual({ pending: 0, failed: 0 })
    expect(world.native('!harmony is nice')).toBe(true)
  })
})

describe('a queue without room', () => {
  it('can still take the fences', () => {
    const world = setup()
    world.relay.acceptFences([{ type: 'm.room.encryption', room_id: roomId }, { type: 'm.room.message', event_id: '$x', room_id: roomId, sender: alice, content: { msgtype: 'm.text', body: 'x' } }])
    expect(world.store.isRoomBlocked(roomId)).toBe(true)
    expect(world.store.counts().pending).toBe(0)
  })
})
