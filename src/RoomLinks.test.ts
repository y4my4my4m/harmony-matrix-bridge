import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostStore } from './HostStore.js'
import { HttpError } from './http.js'
import type { MatrixEvent } from './Relay.js'
import { RoomLinks } from './RoomLinks.js'

const room = '!room:matrix.test'
const alice = '@alice:matrix.test'
const bot = '@harmony_relay:matrix.test'
const code = 'ML-AAAA-BBBB-CCCC'
const stores: HostStore[] = []
afterEach(() => { vi.useRealTimers(); stores.splice(0).forEach(store => store.close()) })

function setup(options: { store?: HostStore } = {}) {
  const matrix = { sendMessage: vi.fn().mockResolvedValue({ event_id: '$n' }), roomMember: vi.fn().mockResolvedValue({}), mayChangeRoom: vi.fn().mockResolvedValue(true), roomIsPlaintext: vi.fn().mockResolvedValue(true) }
  const api = { link: vi.fn().mockResolvedValue({ bridgeId: 'b1', serverName: 'Server', channelName: 'general' }) }
  const store = options.store ?? new HostStore(':memory:')
  if (!stores.includes(store)) stores.push(store)
  const onLinked = vi.fn()
  const onEncrypted = vi.fn()
  const lines: string[] = []
  const links = new RoomLinks({ matrix, api, store, isPerson: id => id !== bot && !id.startsWith('@harmony_relay_h_'), onLinked, onEncrypted, publicUrl: 'https://harmony.test', report: line => { lines.push(line) } })
  let serial = 0
  const post = async (body: unknown, extra: Partial<MatrixEvent> = {}) => {
    const { content, ...rest } = extra
    links.take([{ type: 'm.room.message', event_id: `$${serial++}`, room_id: room, sender: alice, ...rest, content: { msgtype: 'm.text', body, ...content } }])
    await links.settled()
  }
  return { matrix, api, store, links, onLinked, onEncrypted, lines, post, said: () => matrix.sendMessage.mock.calls.map(call => call[2] as string) }
}

describe('linking a room', () => {
  it('asks Harmony and answers the person once, without the code', async () => {
    const { post, api, matrix, onLinked, said, lines } = setup()
    await post(`!harmony link ${code.toLowerCase()}`)
    expect(api.link).toHaveBeenCalledExactlyOnceWith(code, room, alice)
    expect(onLinked).toHaveBeenCalledExactlyOnceWith(room, 'b1')
    expect(matrix.sendMessage).toHaveBeenCalledExactlyOnceWith(room, expect.stringMatching(/^[0-9a-f]{64}$/), 'This room is now linked with #general on Server.', { notice: true, userIds: [alice], replyTo: '$0' })
    expect(JSON.stringify([said(), lines])).not.toContain('AAAA')
  })
  it('takes it from someone in the room with the power to change it alone', async () => {
    const { post, api, matrix, said } = setup()
    matrix.mayChangeRoom.mockResolvedValue(false)
    await post(`!harmony link ${code}`)
    expect(matrix.mayChangeRoom).toHaveBeenCalledWith(room, alice)
    matrix.mayChangeRoom.mockResolvedValue(true)
    matrix.roomMember.mockRejectedValue(new HttpError('not joined', false))
    await post(`!harmony link ${code}`)
    matrix.roomMember.mockResolvedValue({})
    matrix.mayChangeRoom.mockRejectedValue(new HttpError('down', true))
    await post(`!harmony link ${code}`)
    expect(api.link).not.toHaveBeenCalled()
    expect(said()).toEqual(['Only someone who may change this room\'s settings can link it with Harmony.'])
  })
  it.each([[new HttpError('x', false, 400, 'invalid_code'), /not valid.*https:\/\/harmony\.test/], [new HttpError('x', false, 409, 'channel_encrypted'), /end-to-end encrypted/],
    [new HttpError('x', true, 503), /not linked/], [new HttpError('x', false, 400), /not linked/]])('says why it did not work', async (error, reason) => {
    const { post, api, onLinked, said } = setup()
    api.link.mockRejectedValue(error)
    await post(`!harmony link ${code}`)
    expect(onLinked).not.toHaveBeenCalled()
    expect(said()).toEqual([expect.stringMatching(reason)])
    expect(said()[0]).not.toContain('AAAA')
  })
  it('explains itself without a code, and spends none', async () => {
    const { post, api, said } = setup()
    await post('!harmony')
    expect(api.link).not.toHaveBeenCalled()
    expect(said()).toEqual([expect.stringContaining('!harmony link')])
  })
  it('refuses an encrypted room before anything else', async () => {
    const { post, api, matrix, onEncrypted } = setup()
    matrix.roomIsPlaintext.mockResolvedValue(false)
    await post(`!harmony link ${code}`)
    expect(onEncrypted).toHaveBeenCalledExactlyOnceWith(room)
    expect(api.link).not.toHaveBeenCalled()
    matrix.roomIsPlaintext.mockRejectedValue(new HttpError('unknown', false, 403))
    await post(`!harmony link ${code}`)
    expect(api.link).not.toHaveBeenCalled()
  })
  it('counts five tries per person in ten minutes, good and bad, then says nothing', async () => {
    const { post, api, said } = setup()
    api.link.mockRejectedValue(new HttpError('x', false, 400, 'invalid_code'))
    for (let index = 0; index < 8; index++) await post(`!harmony link ML-${index}`)
    expect(api.link).toHaveBeenCalledTimes(5)
    expect(said()).toHaveLength(5)
    await post(`!harmony link ${code}`, { sender: '@bob:matrix.test' })
    expect(api.link).toHaveBeenCalledTimes(6)
  })
  it('works on an event once, whoever repeats it', async () => {
    const { post, api, store } = setup()
    await post(`!harmony link ${code}`, { event_id: '$same' })
    await post(`!harmony link ${code}`, { event_id: '$same' })
    const again = setup({ store })
    await again.post(`!harmony link ${code}`, { event_id: '$same' })
    expect(api.link).toHaveBeenCalledOnce()
    expect(again.api.link).not.toHaveBeenCalled()
  })
  it('looks at what people say alone: not its own words, edits, notices, captions or other text', async () => {
    const { post, matrix, api } = setup()
    const command = `!harmony link ${code}`
    await post(command, { sender: bot })
    await post(command, { sender: '@harmony_relay_h_11111111111141118111111111111111:matrix.test' })
    await post(command, { content: { msgtype: 'm.notice' } })
    await post(command, { content: { msgtype: 'm.image' } })
    await post(`* ${command}`, { content: { 'm.new_content': { body: command } } })
    await post(command, { content: { 'm.new_content': { body: command } } })
    await post('hello')
    await post(command, { type: 'm.reaction' })
    await post(command, { event_id: undefined })
    await post(7)
    expect(matrix.roomIsPlaintext).not.toHaveBeenCalled()
    expect(api.link).not.toHaveBeenCalled()
  })
  it('links all the same where it may not answer', async () => {
    const { post, matrix, onLinked, lines } = setup()
    matrix.sendMessage.mockRejectedValue(new HttpError('may not send', false, 403))
    await post(`!harmony link ${code}`)
    expect(onLinked).toHaveBeenCalledOnce()
    expect(lines).toEqual(['An answer about linking a room could not be posted there'])
  })
  it('bounds the notices of a room and what runs at once', async () => {
    const { post, said, links, matrix } = setup()
    for (let index = 0; index < 30; index++) await post('!harmony', { sender: `@p${index}:matrix.test` })
    expect(said()).toHaveLength(20)
    matrix.roomIsPlaintext.mockClear()
    matrix.roomIsPlaintext.mockImplementation(() => new Promise(() => {}))
    links.take(Array.from({ length: 50 }, (_, index) => ({ type: 'm.room.message', event_id: `$many${index}`, room_id: room, sender: `@q${index}:matrix.test`, content: { msgtype: 'm.text', body: '!harmony' } })))
    expect(matrix.roomIsPlaintext).toHaveBeenCalledTimes(20)
  })
})
