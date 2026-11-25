import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostStore } from './HostStore.js'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('HostStore', () => {
  it('keeps the rooms the account is in across a restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mxb-'))
    directories.push(directory)
    const path = join(directory, 'host.sqlite')
    const store = new HostStore(path)
    store.saveRoom({ roomId: '!a:x', bridgeId: null, waitingSince: 5 })
    store.saveRoom({ roomId: '!b:x', bridgeId: 'one', waitingSince: null })
    store.saveRoom({ roomId: '!a:x', bridgeId: 'two', waitingSince: 7 })
    expect(store.takeTry('$e', '@a:x', 1)).toBe('taken')
    store.close()
    const again = new HostStore(path)
    expect(again.rooms()).toEqual([{ roomId: '!a:x', bridgeId: 'two', waitingSince: 7 }, { roomId: '!b:x', bridgeId: 'one', waitingSince: null }])
    again.dropRoom('!a:x')
    expect(again.rooms()).toHaveLength(1)
    expect(again.takeTry('$e', '@a:x', 1)).toBe('repeated')
    again.close()
  })
  it('lets a sender try five times in ten minutes, and each event once', () => {
    const store = new HostStore(':memory:')
    for (let index = 0; index < 5; index++) expect(store.takeTry(`$${index}`, '@a:x', 1_000 + index)).toBe('taken')
    expect(store.takeTry('$0', '@a:x', 1_010)).toBe('repeated')
    expect(store.takeTry('$5', '@a:x', 1_010)).toBe('refused')
    expect(store.takeTry('$5', '@a:x', 10_000_000)).toBe('repeated')
    expect(store.takeTry('$6', '@b:x', 1_010)).toBe('taken')
    // The refused ones did not count; the first five are gone from the window.
    expect(store.takeTry('$7', '@a:x', 1_000 + 10 * 60_000)).toBe('taken')
    expect(store.takeTry('$8', '@a:x', 1_000 + 10 * 60_000)).toBe('refused')
    store.close()
  })
})
