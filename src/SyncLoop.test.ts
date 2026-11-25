import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpError, ResponseTooLarge } from './http.js'
import type { SyncBatch, SyncRoom } from './MatrixClient.js'
import { Relay } from './Relay.js'
import { Store } from './Store.js'
import { SyncLoop, TOKEN_HINT } from './SyncLoop.js'

const me = '@community:matrix.test'
const A = '!a:matrix.test'
const B = '!b:matrix.test'
const stores: Store[] = []
const loops: SyncLoop[] = []
afterEach(async () => { vi.useRealTimers(); for (const loop of loops.splice(0)) await loop.stop(); stores.splice(0).forEach(store => store.close()) })

const text = (id: string, extra: Record<string, unknown> = {}) => ({ type: 'm.room.message', event_id: id, sender: '@alice:matrix.test', content: { msgtype: 'm.text', body: id }, ...extra })
const encryption = { type: 'm.room.encryption', state_key: '', event_id: '$encryption', sender: '@alice:matrix.test', content: { algorithm: 'm.megolm.v1.aes-sha2' } }
const room = (events: unknown[] = [], extra: Partial<SyncRoom['timeline']> = {}, state: unknown[] = []): SyncRoom => ({ timeline: { events, limited: false, ...extra }, state })
const batch = (nextBatch: string, joined: Record<string, SyncRoom> = {}, extra: Partial<SyncBatch> = {}): SyncBatch =>
  ({ nextBatch, joined: new Map(Object.entries(joined)), invited: new Map(), left: [], ...extra })

const hang = ({ signal }: { signal?: AbortSignal }) => new Promise<SyncBatch>((_, reject) => {
  signal?.addEventListener('abort', () => reject(new HttpError('HTTP request aborted', true)))
})

function setup(rooms: string[] = [A]) {
  const store = new Store(':memory:')
  stores.push(store)
  const settings = { pairs: [A, B].map((matrixRoomId, index) => ({ harmonyChannelId: `${index}2222222-2222-4222-8222-222222222222`, matrixRoomId, direction: 'both' as const, senderMode: 'relay' as const })),
    harmony: {}, matrix: { serverName: 'matrix.test', userId: me } }
  const relay = new Relay(settings, store, {} as never, {} as never)
  const matrix = { sync: vi.fn(), createFilter: vi.fn().mockResolvedValue('filter'), messages: vi.fn() }
  const onMembership = vi.fn()
  const followed = [...rooms]
  const loop = new SyncLoop({ matrix, store, relay, userId: me, rooms: () => followed, onMembership, pollMs: 30_000 })
  loops.push(loop)
  const jobs = () => {
    const ids: string[] = []
    for (let job = store.nextJob(); job; job = store.nextJob()) { ids.push(job.sourceId); store.finish(job.id) }
    return ids
  }
  return { store, relay, matrix, loop, jobs, followed, onMembership }
}
const started = (store: Store, token = 's0', rooms = [A]) => store.acceptSync(me, token, rooms, [])

describe('SyncLoop', () => {
  it('relays no history on the first sync, and keeps its token and fences', async () => {
    const { matrix, loop, store, jobs } = setup([A, B])
    matrix.sync.mockResolvedValue(batch('s1', { [A]: room([text('$old')]), [B]: room([], {}, [encryption]) }))
    await loop.once()
    expect(matrix.sync).toHaveBeenCalledWith(expect.objectContaining({ since: undefined, timeoutMs: 0, filter: 'filter' }))
    expect(matrix.createFilter.mock.calls[0][0].room).toMatchObject({ rooms: [A, B], timeline: { limit: 1, types: ['m.room.message', 'm.room.encryption', 'm.room.member'] }, state: { types: ['m.room.encryption'] } })
    expect(jobs()).toEqual([])
    expect(store.syncState(me)).toEqual({ nextBatch: 's1', rooms: [A, B] })
    expect(store.isRoomBlocked(B)).toBe(true)
    expect(store.isRoomBlocked(A)).toBe(false)
  })
  it('relays what comes after, with the room it came from, long polling from the stored token', async () => {
    const { matrix, loop, store, jobs } = setup()
    started(store)
    matrix.sync.mockResolvedValue(batch('s1', { [A]: room([text('$one'), text('$own', { sender: me })]), [B]: room([text('$unfollowed')]) }))
    await loop.once()
    expect(matrix.sync).toHaveBeenCalledWith(expect.objectContaining({ since: 's0', timeoutMs: 30_000 }))
    expect(jobs()).toEqual(['$one'])
    expect(store.syncState(me)!.nextBatch).toBe('s1')
  })
  it('treats a newly paired room\'s first response as history, and relays the next', async () => {
    const { matrix, loop, store, jobs, followed } = setup([A])
    started(store)
    followed.push(B)
    matrix.sync.mockResolvedValueOnce(batch('s1', { [A]: room([text('$a')]), [B]: room([text('$before')]) }))
      .mockResolvedValueOnce(batch('s2', { [B]: room([text('$after')]) }))
    await loop.once()
    expect(matrix.sync.mock.calls[0][0].timeoutMs).toBe(0)
    expect(jobs()).toEqual(['$a'])
    await loop.once()
    expect(matrix.sync.mock.calls[1][0].timeoutMs).toBe(30_000)
    expect(jobs()).toEqual(['$after'])
  })
  it('fences an encrypted room from its state and its timeline, with the messages of the same response', async () => {
    for (const where of ['state', 'timeline'] as const) {
      const { matrix, loop, store } = setup()
      started(store)
      matrix.sync.mockResolvedValue(batch('s1', { [A]: where === 'state' ? room([text('$one')], {}, [encryption]) : room([text('$one'), encryption]) }))
      await loop.once()
      expect(store.isRoomBlocked(A)).toBe(true)
    }
  })
  it('reads the gap of a limited timeline back, oldest first, with its fence, each event once', async () => {
    const { matrix, loop, store, jobs } = setup()
    started(store)
    matrix.sync.mockResolvedValue(batch('s1', { [A]: room([text('$5'), text('$6')], { limited: true, prev_batch: 'p1' }) }))
    matrix.messages.mockResolvedValueOnce({ events: [text('$5'), text('$4'), text('$3')], end: 'p2' })
      .mockResolvedValueOnce({ events: [encryption, text('$2')], end: undefined })
    await loop.once()
    const types = ['m.room.message', 'm.room.encryption', 'm.room.member']
    expect(matrix.messages.mock.calls).toEqual([[A, 'p1', 's0', types], [A, 'p2', 's0', types]])
    expect(store.isRoomBlocked(A)).toBe(true)
    expect(jobs()).toEqual(['$2', '$3', '$4', '$5', '$6'])
    expect(loop.problems()).not.toContainEqual(expect.objectContaining({ code: 'messages_skipped' }))
  })
  it('says which room lost messages when a gap is too long or cannot be read', async () => {
    const { matrix, loop, store, jobs } = setup()
    started(store)
    matrix.sync.mockResolvedValue(batch('s1', { [A]: room([text('$new')], { limited: true, prev_batch: 'p' }) }))
    let page = 0
    matrix.messages.mockImplementation(async () => ({ events: [text(`$gap${page}`)], end: `p${++page}` }))
    await loop.once()
    expect(matrix.messages).toHaveBeenCalledTimes(10)
    expect(jobs()).toHaveLength(11)
    expect(loop.problems()).toContainEqual({ code: 'messages_skipped', detail: expect.stringContaining(A) })
    const refused = setup()
    started(refused.store)
    refused.matrix.sync.mockResolvedValue(batch('s1', { [A]: room([text('$new')], { limited: true, prev_batch: 'p' }) }))
    refused.matrix.messages.mockRejectedValue(new HttpError('no', false, 403))
    await refused.loop.once()
    expect(refused.jobs()).toEqual(['$new'])
    expect(refused.loop.problems()).toContainEqual(expect.objectContaining({ code: 'messages_skipped' }))
  })
  it('does not move on while a gap cannot be read for now', async () => {
    const { matrix, loop, store, jobs } = setup()
    started(store)
    matrix.sync.mockResolvedValue(batch('s1', { [A]: room([text('$new')], { limited: true, prev_batch: 'p' }) }))
    matrix.messages.mockRejectedValueOnce(new HttpError('busy', true, 503))
    await expect(loop.once()).rejects.toThrow()
    expect(store.syncState(me)!.nextBatch).toBe('s0')
    matrix.messages.mockResolvedValue({ events: [text('$gap')] })
    await loop.once()
    expect(jobs()).toEqual(['$gap', '$new'])
  })
  it('keeps the token, the jobs and the fences out together when the queue is full', async () => {
    const { matrix, loop, store, jobs } = setup()
    started(store)
    for (let index = 0; index < 10_000; index++) store.enqueue({ direction: 'to_matrix', sourceId: String(index), channelId: 'c', roomId: A, payload: {} })
    matrix.sync.mockResolvedValue(batch('s1', { [A]: room([text('$one')], {}, [encryption]) }))
    await expect(loop.once()).rejects.toThrow(/quota/)
    expect(store.syncState(me)!.nextBatch).toBe('s0')
    expect(store.isRoomBlocked(A)).toBe(false)
    jobs()
    await loop.once()
    expect(store.syncState(me)!.nextBatch).toBe('s1')
    expect(jobs()).toEqual(['$one'])
    expect(store.isRoomBlocked(A)).toBe(true)
  }, 20_000)
  it('keeps invites and drops a room it left, whose return is history again', async () => {
    const { matrix, loop, store, jobs, onMembership } = setup()
    started(store)
    matrix.sync.mockResolvedValueOnce(batch('s1', {}, { invited: new Map([['!invited:matrix.test', [{ type: 'm.room.name', content: { name: 'Come in' } }]]]), left: [A] }))
      .mockResolvedValueOnce(batch('s2', { [A]: room([text('$before')], { limited: true, prev_batch: 'p' }) }))
    await loop.once()
    expect(store.invites()).toEqual([{ roomId: '!invited:matrix.test', name: 'Come in', alias: null, encrypted: false }])
    expect(onMembership.mock.calls).toEqual([['!invited:matrix.test', 'invite'], [A, 'leave']])
    expect(store.syncState(me)!.rooms).toEqual([])
    await loop.once()
    expect(matrix.messages).not.toHaveBeenCalled()
    expect(jobs()).toEqual([])
  })
  it('copies nothing from before the account came back into a room, and takes a new name for no return', async () => {
    const member = (membership: string, previous?: string, key = me) => ({ type: 'm.room.member', state_key: key, event_id: `$${membership}${previous}${key}`, sender: key,
      content: { membership }, ...(previous ? { unsigned: { prev_content: { membership: previous } } } : {}) })
    const { matrix, loop, store, jobs } = setup()
    started(store)
    matrix.sync.mockResolvedValueOnce(batch('s1', { [A]: room([text('$out'), encryption, member('join', 'leave'), text('$in')], { limited: true, prev_batch: 'p' }) }))
      .mockResolvedValueOnce(batch('s2', { [A]: room([text('$a'), member('join', 'join'), text('$b'), member('join', 'leave', '@alice:matrix.test'), text('$c')]) }))
    matrix.messages.mockResolvedValue({ events: [text('$earlier')] })
    await loop.once()
    expect(jobs()).toEqual(['$in'])
    expect(store.isRoomBlocked(A)).toBe(true)
    await loop.once()
    expect(jobs()).toEqual(['$a', '$b', '$c'])
  })
  it('takes an invite to a followed room as having left it', async () => {
    const { matrix, loop, store, onMembership } = setup()
    started(store)
    matrix.sync.mockResolvedValue(batch('s1', {}, { invited: new Map([[A, []]]) }))
    await loop.once()
    expect(store.syncState(me)!.rooms).toEqual([])
    expect(store.isInvited(A)).toBe(true)
    expect(onMembership).toHaveBeenCalledExactlyOnceWith(A, 'invite')
  })
  it('polls with a filter of the paired rooms alone and makes it once', async () => {
    const { matrix, loop, store, followed } = setup()
    started(store)
    matrix.sync.mockResolvedValue(batch('s1'))
    await loop.once(); await loop.once()
    expect(matrix.createFilter).toHaveBeenCalledOnce()
    followed.length = 0
    await loop.once()
    expect(matrix.createFilter.mock.calls[1][0].room.rooms).toEqual(['!none:invalid'])
  })

  it('reports a refused token, an unreachable homeserver and its return, and stops at once', async () => {
    vi.useFakeTimers()
    const { matrix, loop, store } = setup()
    started(store)
    expect(loop.connected).toBe(false)
    matrix.sync.mockRejectedValueOnce(new HttpError('down', true, 502)).mockRejectedValueOnce(new HttpError('expired', false, 401, 'M_UNKNOWN_TOKEN'))
      .mockImplementation(hang)
    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(loop.problems()).toEqual([{ code: 'matrix_unreachable' }])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(loop.problems()).toEqual([{ code: 'matrix_token_invalid', detail: TOKEN_HINT }])
    expect(TOKEN_HINT.length).toBeLessThanOrEqual(200)
    await vi.advanceTimersByTimeAsync(59_000)
    expect(matrix.sync).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(matrix.sync).toHaveBeenCalledTimes(3)
  })
  it('asks anew for the right rooms when pairs change during a poll', async () => {
    const { matrix, loop, store, followed } = setup()
    started(store)
    matrix.sync.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new HttpError('HTTP request aborted', true)))
      if (matrix.sync.mock.calls.length === 2) resolve(batch('s1'))
    }))
    loop.start()
    await vi.waitFor(() => expect(matrix.sync).toHaveBeenCalledOnce())
    followed.push(B)
    loop.roomsChanged()
    await vi.waitFor(() => expect(matrix.sync.mock.calls.length).toBeGreaterThanOrEqual(3))
    expect(matrix.createFilter.mock.calls[1][0].room.rooms).toEqual([A, B])
    expect(loop.connected).toBe(true)
  })
  it('asks for less when a response is too large, and starts over from now when nothing fits', async () => {
    vi.useFakeTimers()
    const { matrix, loop, store } = setup()
    started(store)
    matrix.sync.mockRejectedValue(new ResponseTooLarge())
    loop.start()
    await vi.advanceTimersByTimeAsync(100)
    const limits = matrix.createFilter.mock.calls.map(call => call[0].room.timeline.limit)
    expect(limits.slice(0, 5)).toEqual([100, 25, 6, 1, 1].slice(0, limits.length))
    expect(limits).toContain(1)
    expect(store.syncState(me)).toBeNull()
    expect(loop.problems()).toContainEqual(expect.objectContaining({ code: 'messages_skipped' }))
  })
  it('gives up a token the homeserver keeps refusing, and relays no history after', async () => {
    vi.useFakeTimers()
    const { matrix, loop, store, jobs } = setup()
    started(store)
    for (let refusal = 0; refusal < 3; refusal++) matrix.sync.mockRejectedValueOnce(new HttpError('unknown pos', false, 400))
    matrix.sync.mockResolvedValueOnce(batch('n1', { [A]: room([text('$old')]) })).mockImplementation(hang)
    loop.start()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(matrix.sync.mock.calls.slice(0, 4).map(call => call[0].since)).toEqual(['s0', 's0', 's0', undefined])
    expect(jobs()).toEqual([])
    expect(store.syncState(me)!.nextBatch).toBe('n1')
  })
  it('goes on after a local storage that failed, without moving its token', async () => {
    vi.useFakeTimers()
    const { matrix, loop, store, jobs } = setup()
    started(store)
    const broken = vi.spyOn(store, 'syncState').mockImplementation(() => { throw new Error('disk') })
    vi.spyOn(store, 'clearSync').mockImplementation(() => { throw new Error('disk') })
    matrix.sync.mockResolvedValueOnce(batch('s1', { [A]: room([text('$one')]) })).mockImplementation(hang)
    loop.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(matrix.sync).not.toHaveBeenCalled()
    broken.mockRestore()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(jobs()).toEqual(['$one'])
  })
  it('does not spin on a homeserver that answers polls at once', async () => {
    vi.useFakeTimers()
    const { matrix, loop, store } = setup()
    started(store)
    matrix.sync.mockImplementation(async () => batch('s1'))
    loop.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(matrix.sync.mock.calls.length).toBeLessThanOrEqual(11)
  })
})
