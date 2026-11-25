import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppService, createHealthServer } from './AppService.js'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })))
})
async function setup(acceptTransaction = vi.fn().mockReturnValue(true), ownsGhost?: (id: string) => boolean, report?: (message: string) => void) {
  const server = createAppService({ hsToken: 'private-token', botUserId: '@relay:test', ownsGhost, acceptTransaction, report, status: () => ({ ready: true, pending: 0, failed: 0 }) })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const put = (body: string, headers: Record<string, string> = { Authorization: 'Bearer private-token' }, path = '/_matrix/app/v1/transactions/one') => fetch(base + path, { method: 'PUT', body, headers })
  return { base, put, acceptTransaction }
}

describe('application-service HTTP', () => {
  it('authenticates before parsing JSON and does not accept query-string credentials', async () => {
    const { put, acceptTransaction } = await setup()
    expect((await put('not JSON', {})).status).toBe(401)
    expect((await put('{}', {}, '/_matrix/app/v1/transactions/one?access_token=private-token')).status).toBe(401)
    expect(acceptTransaction).not.toHaveBeenCalled()
  })
  it('acknowledges durable acceptance and duplicate transactions identically', async () => {
    const { put, acceptTransaction } = await setup(vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false))
    const event = { type: 'm.room.message', event_id: '$one', content: { body: 'hello', msgtype: 'm.text' } }
    for (let i = 0; i < 2; i++) {
      const response = await put(JSON.stringify({ events: [event] }))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({})
    }
    expect(acceptTransaction).toHaveBeenCalledWith('one', [event])
  })
  it('does not acknowledge storage failures or expose exception contents', async () => {
    const { put } = await setup(vi.fn().mockImplementation(() => { throw new Error('secret-token') }))
    const response = await put('{"events":[]}')
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('secret-token')
  })
  it('bounds request bodies, validates transaction shape and handles malformed IDs', async () => {
    const { put, acceptTransaction } = await setup()
    const to = (id: string) => `/_matrix/app/v1/transactions/${id}`
    expect((await put('not JSON', undefined, to('a'))).status).toBe(400)
    expect((await put('{"events":{}}', undefined, to('b'))).status).toBe(400)
    expect((await put('null', undefined, to('c'))).status).toBe(400)
    expect((await put('{"events":[]}', undefined, to('%zz'))).status).toBe(400)
    expect((await put('x'.repeat(8 * 1024 * 1024 + 1), undefined, to('d'))).status).toBe(413)
    expect(acceptTransaction).not.toHaveBeenCalled()
  })
  it('takes the largest legal transaction, 100 events of 64 KiB', async () => {
    const { put, acceptTransaction } = await setup()
    const events = Array.from({ length: 100 }, (_, index) => ({ type: 'm.room.message', event_id: `$${index}`, content: { msgtype: 'm.text', body: 'x'.repeat(65_000) } }))
    expect((await put(JSON.stringify({ events }))).status).toBe(200)
    expect(acceptTransaction.mock.calls[0][1]).toHaveLength(100)
  })
  it('leaves out the events it cannot read and keeps the others and every fence', async () => {
    const { put, acceptTransaction } = await setup()
    const good = { type: 'm.room.message', event_id: '$good', content: { body: 'hello', msgtype: 'm.text' } }
    const events = [null, 42, 'text', [], {}, { type: 7 }, { type: 'm.room.message', content: 'no object' }, { type: 'm.room.message', event_id: 'x'.repeat(300) }, good,
      { type: 'm.room.encryption', room_id: '!a:test', content: 'no object', event_id: 12 }, { type: 'm.room.encryption', content: 'no room' }]
    expect((await put(JSON.stringify({ events }))).status).toBe(200)
    expect(acceptTransaction).toHaveBeenCalledExactlyOnceWith('one', [good, { type: 'm.room.encryption', room_id: '!a:test' }])
  })
  it.each([['not JSON', 400], ['{"events":{}}', 400], ['x'.repeat(8 * 1024 * 1024 + 1), 413]])('lets a transaction it can never read go at the third try, one with a good body before (%#)', async (bad, status) => {
    const report = vi.fn()
    const { put, acceptTransaction } = await setup(undefined, undefined, report)
    for (const expected of [status, status, 200]) expect((await put(bad)).status).toBe(expected)
    expect(acceptTransaction).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledOnce()
    expect((await put(bad)).status).toBe(status)
    expect((await put('{"events":[]}')).status).toBe(200)
    expect(acceptTransaction).toHaveBeenCalledOnce()
    expect((await put(bad)).status).toBe(status)
  })
  it('does not let go of a transaction that storage refuses', async () => {
    const { put } = await setup(vi.fn().mockImplementation(() => { throw new Error('disk') }))
    for (let index = 0; index < 6; index++) expect((await put('{"events":[]}')).status).toBe(503)
  })
  it('answers only durably owned ghosts without provisioning unknown namespace users', async () => {
    const ghost = '@relay_h_11111111111141118111111111111111:test'
    const ownsGhost = vi.fn(id => id === ghost)
    const { base } = await setup(undefined, ownsGhost)
    const path = '/_matrix/app/v1/users/' + encodeURIComponent(ghost)
    expect((await fetch(base + path)).status).toBe(401)
    expect(ownsGhost).not.toHaveBeenCalled()
    const headers = { Authorization: 'Bearer private-token' }
    expect((await fetch(base + path, { headers })).status).toBe(200)
    expect((await fetch(base + '/_matrix/app/v1/users/%40relay_h_22222222222242228222222222222222%3Atest', { headers })).status).toBe(404)
  })
  it('answers only its exact user namespace and exposes no secrets in health', async () => {
    const { base } = await setup()
    const headers = { Authorization: 'Bearer private-token' }
    expect((await fetch(base + '/_matrix/app/v1/users/%40relay%3Atest', { headers })).status).toBe(200)
    expect((await fetch(base + '/_matrix/app/v1/users/%40other%3Atest', { headers })).status).toBe(404)
    const health = await fetch(base + '/health')
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ready: true, pending: 0, failed: 0 })
  })

  it('answers /health alone for a bridge no homeserver calls', async () => {
    let ready = false
    let broken = false
    const server = createHealthServer(() => {
      if (broken) throw new Error('disk SECRET')
      return { ready, pending: 1, failed: 0, problems: ['matrix_unreachable'] }
    })
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    expect((await fetch(base + '/health')).status).toBe(503)
    ready = true
    const health = await fetch(base + '/health')
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ready: true, pending: 1, failed: 0, problems: ['matrix_unreachable'] })
    expect((await fetch(base + '/_matrix/app/v1/transactions/one', { method: 'PUT', body: '{"events":[]}' })).status).toBe(404)
    expect((await fetch(base + '/health', { method: 'POST' })).status).toBe(404)
    broken = true
    const failed = await fetch(base + '/health')
    expect(failed.status).toBe(503)
    expect(await failed.text()).not.toContain('SECRET')
  })
})
