import { describe, expect, it, vi } from 'vitest'
import { HttpError } from './http.js'
import { OptOutList } from './OptOuts.js'
import { parsePrivacyCommand, PrivacyDesk } from './Privacy.js'

const alice = '@alice:test'
function desk(oneServer = true, options: { supported?: boolean; onChange?: () => void } = {}) {
  const api = { optOuts: vi.fn().mockResolvedValue({ version: '1', ids: [alice] }), optOut: vi.fn(), setOptOut: vi.fn(), erase: vi.fn() }
  return { api, desk: new PrivacyDesk(api, { oneServer, ...options }) }
}

describe('the command', () => {
  it.each([['!bridge-privacy opt-out', 'opt-out'], [' !Bridge-Privacy   OPT-IN ', 'opt-in'], ['!bridge-privacy status', 'status'], ['!bridge-privacy erase', 'erase'],
    ['!bridge-privacy erase  confirm', 'erase confirm'], ['!bridge-privacy', 'help'], ['!bridge-privacy opt-out please', 'help'], ['!bridge-privacyopt-out', null],
    ['hey !bridge-privacy opt-out', null], ['!bridge-privacy ' + 'x'.repeat(300), null], [42, null]])('reads %j as %s', (body, command) => {
    expect(parsePrivacyCommand(body)).toBe(command)
  })
})

describe('opt-out lists', () => {
  it('follow the version the configuration names, one read at a time', async () => {
    const { api, desk: privacy } = desk()
    await Promise.all([privacy.load('', '1'), privacy.load('', '1')])
    expect(api.optOuts).toHaveBeenCalledOnce()
    expect(privacy.optedOut('any channel', alice)).toBe(true)
    await privacy.load('', '1')
    expect(api.optOuts).toHaveBeenCalledOnce()
    api.optOuts.mockResolvedValue({ version: '2', ids: [] })
    await privacy.load('', '2')
    expect(privacy.optedOut('any channel', alice)).toBe(false)
  })
  it('stay as they were when a read fails, and are read again', async () => {
    const { api, desk: privacy } = desk()
    await privacy.load('', '1')
    api.optOuts.mockRejectedValueOnce(new HttpError('down', true, 503))
    await expect(privacy.load('', '2')).rejects.toThrow()
    expect(privacy.optedOut('', alice)).toBe(true)
    api.optOuts.mockResolvedValue({ version: '2', ids: [] })
    await privacy.load('', '2')
    expect(privacy.optedOut('', alice)).toBe(false)
  })
  it('are each channel\'s own for a bot that may serve several servers', async () => {
    const { api, desk: privacy } = desk(false)
    await privacy.load('channel-a')
    expect(api.optOuts).toHaveBeenCalledWith('channel-a')
    expect(privacy.optedOut('channel-a', alice)).toBe(true)
    expect(privacy.optedOut('channel-b', alice)).toBe(false)
    api.setOptOut.mockResolvedValue({ optedOut: true, source: 'user' })
    await privacy.run('channel-b', alice, 'opt-out')
    expect(api.setOptOut).toHaveBeenCalledWith(alice, true, 'channel-b')
    expect(privacy.optedOut('channel-b', alice)).toBe(true)
  })
  it('keep a choice made while a read was in flight', async () => {
    const changed = vi.fn()
    const list = new OptOutList(changed)
    let finish!: (value: { version: string; ids: string[] }) => void
    const load = list.load(() => new Promise(resolve => { finish = resolve }))
    list.add('@new:test')
    list.remove('@back:test')
    finish({ version: '1', ids: ['@back:test', '@old:test'] })
    await load
    expect(list.has('@new:test')).toBe(true)
    expect(list.has('@back:test')).toBe(false)
    expect(list.has('@old:test')).toBe(true)
    expect(changed).toHaveBeenCalled()
  })
})

describe('limits', () => {
  it('count five commands a person and twenty answers a room, each minute', () => {
    const { desk: privacy } = desk()
    const asks = (now: number) => Array.from({ length: 7 }, () => privacy.mayAsk(alice, now)).filter(Boolean).length
    expect(asks(0)).toBe(5)
    expect(privacy.mayAsk('@bob:test', 0)).toBe(true)
    expect(asks(59_999)).toBe(0)
    expect(asks(60_000)).toBe(5)
    expect(Array.from({ length: 30 }, () => privacy.mayReply('!room', 0)).filter(Boolean)).toHaveLength(20)
    expect(privacy.mayReply('!other', 0)).toBe(true)
  })
})

describe('answers', () => {
  it.each([403, 404])('read HTTP %s as a Harmony without the routes', async status => {
    const { api, desk: privacy } = desk()
    api.optOut.mockRejectedValue(new HttpError('no', false, status))
    await expect(privacy.run('', alice, 'status')).resolves.toContain('does not offer that yet')
  })
  it('throw what may pass', async () => {
    const { api, desk: privacy } = desk()
    api.setOptOut.mockRejectedValue(new HttpError('down', true, 503))
    await expect(privacy.run('', alice, 'opt-out')).rejects.toThrow('down')
    expect(privacy.optedOut('', alice)).toBe(false)
  })
  it('say that an erase goes on in the background', async () => {
    const { api, desk: privacy } = desk()
    api.erase.mockResolvedValue({ erased: 200, more: true })
    await expect(privacy.run('', alice, 'erase confirm')).resolves.toContain('in the background')
  })
})
