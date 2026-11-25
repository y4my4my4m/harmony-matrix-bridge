import { describe, expect, it } from 'vitest'
import { isRoomCommand, roomCode, withoutQuote } from './RoomCommand.js'

describe('the link command', () => {
  it.each([['!harmony link ML-AAAA-BBBB-CCCC', 'ML-AAAA-BBBB-CCCC'], ['  !Harmony   LINK\tml-aaaa-bbbb-cccc  ', 'ML-AAAA-BBBB-CCCC'], ['!harmony link', ''], ['!harmony', ''], ['!harmony link a b', ''],
    ['!harmony link ' + 'x'.repeat(65), ''], ['> <@a:x> hello\n> more\n\n!harmony link ML-1', 'ML-1'], ['!harmony link\nML-2', 'ML-2']])('knows %j', (body, code) => {
    expect(isRoomCommand(body)).toBe(true)
    expect(roomCode(body)).toBe(code)
  })
  it.each(['harmony link ML-1', 'say !harmony link ML-1', '!harmonylink ML-1', '!harmony linking', '!harmony is a bridge', '! harmony link', '', '> !harmony link ML-1'])('leaves %j alone', body => {
    expect(isRoomCommand(body)).toBe(false)
  })
  it('reads no body that is no text, and a long one in no time', () => {
    for (const body of [null, undefined, 7, {}, ['!harmony link x']]) expect(isRoomCommand(body)).toBe(false)
    const started = performance.now()
    for (const body of [' '.repeat(65_000), '> '.repeat(30_000), '> \n'.repeat(20_000) + '!harmony', '!harmony' + ' '.repeat(65_000), '!harmony link ' + 'x '.repeat(30_000)]) { isRoomCommand(body); roomCode(body) }
    expect(performance.now() - started).toBeLessThan(100)
    expect(withoutQuote('> a\n\nb')).toBe('b')
  })
})
