import { describe, expect, it, vi } from 'vitest'
import { HttpError } from './http.js'
import type { RoomInfo } from './MatrixClient.js'
import { RoomDirectory } from './Rooms.js'

const info = (room_id: string): RoomInfo => ({ room_id, name: room_id, alias: null, encrypted: false, can_send: true, members: 2 })
function setup(joined: string[], options: { account?: boolean; paired?: string[]; invites?: string[] } = {}) {
  const matrix = { joinedRooms: vi.fn(async () => joined), directRooms: vi.fn(async () => new Set(['!dm'])), roomInfo: vi.fn(async (id: string): Promise<RoomInfo | null> => info(id)) }
  const invites = () => (options.invites ?? []).map(roomId => ({ roomId, name: 'Invited', alias: null, encrypted: false }))
  return { matrix, rooms: new RoomDirectory({ matrix, store: { invites }, account: options.account ?? false, paired: () => options.paired ?? [] }) }
}

describe('RoomDirectory', () => {
  it('lists joined rooms first and fills what is left of 500 with invites', async () => {
    const joined = Array.from({ length: 498 }, (_, index) => `!room${index}`)
    const { rooms } = setup(joined, { invites: ['!room3', '!x', '!y', '!z'] })
    for (let pass = 0; pass < 30; pass++) await rooms.refresh(pass)
    const list = rooms.list()
    expect(list).toHaveLength(500)
    expect(list.slice(0, 498).every(room => !room.invited)).toBe(true)
    expect(list.slice(498)).toEqual([{ room_id: '!x', name: 'Invited', alias: null, encrypted: false, can_send: true, members: 0, invited: true },
      { room_id: '!y', name: 'Invited', alias: null, encrypted: false, can_send: true, members: 0, invited: true }])
  })
  it('never loses a paired room to the limit', async () => {
    const joined = Array.from({ length: 600 }, (_, index) => `!room${index}`)
    const { rooms } = setup(joined, { paired: ['!room599'], invites: ['!x'] })
    for (let pass = 0; pass < 40; pass++) await rooms.refresh(pass)
    expect(rooms.list()).toHaveLength(500)
    expect(rooms.list()[0].room_id).toBe('!room599')
  })
  it('leaves out an account\'s direct chats and spaces', async () => {
    const { rooms, matrix } = setup(['!dm', '!space', '!room'], { account: true })
    matrix.roomInfo.mockImplementation(async id => id === '!space' ? null : info(id))
    await rooms.refresh(0)
    expect(rooms.list().map(room => room.room_id)).toEqual(['!room'])
    expect(matrix.roomInfo).not.toHaveBeenCalledWith('!dm')
  })
  it('reads a few rooms at a time and each again after ten minutes', async () => {
    const { rooms, matrix } = setup(Array.from({ length: 25 }, (_, index) => `!room${index}`))
    await rooms.refresh(0)
    expect(matrix.roomInfo).toHaveBeenCalledTimes(20)
    await rooms.refresh(1)
    await rooms.refresh(2)
    expect(matrix.roomInfo).toHaveBeenCalledTimes(25)
    await rooms.refresh(10 * 60_000 + 2)
    expect(matrix.roomInfo).toHaveBeenCalledTimes(45)
  })
  it('drops rooms it left, skips refused ones and keeps what it knew through an outage', async () => {
    const joined = ['!a', '!refused', '!b']
    const { rooms, matrix } = setup(joined)
    matrix.roomInfo.mockImplementation(async id => { if (id === '!refused') throw new HttpError('no', false, 403); return info(id) })
    await rooms.refresh(0)
    expect(rooms.list().map(room => room.room_id)).toEqual(['!a', '!b'])
    matrix.joinedRooms.mockRejectedValueOnce(new HttpError('down', true))
    await expect(rooms.refresh(1)).rejects.toThrow()
    expect(rooms.list()).toHaveLength(2)
    joined.splice(0, 1)
    await rooms.refresh(2)
    expect(rooms.list().map(room => room.room_id)).toEqual(['!b'])
  })
  it('describes the rooms it is given and asks for no others', async () => {
    const matrix = { joinedRooms: vi.fn(), directRooms: vi.fn(), roomInfo: vi.fn(async (id: string): Promise<RoomInfo | null> => info(id)) }
    let given = ['!a', '!b']
    const rooms = new RoomDirectory({ matrix, store: { invites: () => [] }, account: true, paired: () => [], rooms: () => given })
    await rooms.refresh(0)
    expect(rooms.list().map(room => room.room_id)).toEqual(['!a', '!b'])
    given = ['!b']
    await rooms.refresh(1)
    expect(rooms.list().map(room => room.room_id)).toEqual(['!b'])
    expect(matrix.roomInfo).toHaveBeenCalledTimes(2)
    expect(matrix.joinedRooms).not.toHaveBeenCalled()
    expect(matrix.directRooms).not.toHaveBeenCalled()
  })
})
