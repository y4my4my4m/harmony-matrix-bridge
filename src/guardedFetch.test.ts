import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer, type Server } from 'node:https'
import { createServer as createTcpServer } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { guardedFetch, homeserverFetch, isPublicAddress } from './guardedFetch.js'
import { discoverHomeserver } from './homeserver.js'
import { HttpError, requestFile, requestJson } from './http.js'
import { MatrixClient } from './MatrixClient.js'

const directory = mkdtempSync(join(tmpdir(), 'mxb-tls-'))
let key: Buffer
let cert: Buffer
beforeAll(() => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=homeserver.test',
    '-addext', 'subjectAltName=DNS:homeserver.test,DNS:other.test,IP:127.0.0.1', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' })
  key = readFileSync(join(directory, 'key.pem'))
  cert = readFileSync(join(directory, 'cert.pem'))
})
afterAll(() => { rmSync(directory, { recursive: true, force: true }) })

const servers: Server[] = []
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } })
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const connections: string[] = []
  const server = createServer({ key, cert }, handler)
  server.on('connection', socket => { connections.push((socket as Socket).remoteAddress ?? '') })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, connections }
}
const loopback = (address: string | undefined) => address === '127.0.0.1'

describe('isPublicAddress', () => {
  it.each(['0.0.0.0', '10.1.2.3', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.255.254', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.1',
    '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::808:808', '64:ff9b:1::1', '100::1', 'fc00::1', 'fd12::1', 'fe80::1', 'fe80::1%eth0',
    'fec0::1', 'ff02::1', '2001::1', '2001:db8::1', '2002:7f00:1::1', '3fff::1', '5f00::1', 'localhost', '', '1.2.3', '2606:4700::1%lo', undefined])('refuses %s', address => {
    expect(isPublicAddress(address)).toBe(false)
  })
  it.each(['1.1.1.1', '8.8.8.8', '9.255.255.255', '11.0.0.1', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '192.0.1.1', '198.17.255.255', '198.20.0.1', '223.255.255.255',
    '2606:4700:4700::1111', '2a00:1450:4001::1', '2001:4860:4860::8888', '3ffe::1'])('takes %s', address => { expect(isPublicAddress(address)).toBe(true) })
})

describe('a guarded request', () => {
  it('sends method, headers and body, and reads the answer, over one connection for several requests', async () => {
    const seen: unknown[] = []
    const { port, connections } = await serve((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        seen.push([req.method, req.url, req.headers.authorization, req.headers['content-type'], req.headers['accept-encoding'], Buffer.concat(chunks).toString()])
        res.writeHead(req.url === '/limited' ? 429 : req.url === '/none' ? 204 : 200, { 'Content-Type': 'application/json', 'Retry-After': '7' }).end(req.url === '/none' ? '' : '{"ok":true}')
      })
    })
    const fetchImpl = guardedFetch({ allows: loopback, resolve: async () => ['127.0.0.1'], ca: cert })
    const base = `https://homeserver.test:${port}`
    expect(await requestJson(new URL(`${base}/a`), { method: 'PUT', headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' }, body: '{"é":1}' }, fetchImpl)).toEqual({ ok: true })
    expect(await requestJson(new URL(`${base}/none`), { method: 'GET' }, fetchImpl)).toBeUndefined()
    await expect(requestJson(new URL(`${base}/limited`), { method: 'GET' }, fetchImpl)).rejects.toMatchObject({ status: 429, retryAfterMs: 7000 })
    expect((await requestFile(new URL(`${base}/file`), { method: 'POST', body: Buffer.from([0, 255]) }, fetchImpl)).bytes.toString()).toBe('{"ok":true}')
    expect(seen[0]).toEqual(['PUT', '/a', 'Bearer x', 'application/json', 'identity', '{"é":1}'])
    expect(connections).toHaveLength(1)
  })
  it('takes https alone', async () => {
    const resolve = vi.fn(async () => ['127.0.0.1'])
    const fetchImpl = guardedFetch({ allows: loopback, resolve, ca: cert })
    for (const url of ['http://homeserver.test/', 'ftp://homeserver.test/', 'ws://homeserver.test/']) await expect(fetchImpl(url)).rejects.toThrow('Address refused')
    expect(resolve).not.toHaveBeenCalled()
  })
  it.each(['127.0.0.1', '[::1]', '[::ffff:127.0.0.1]', '2130706433', '0x7f.1', '0177.0.0.1', '10.0.0.1', '169.254.169.254', '[64:ff9b::7f00:1]', '[fd00::1]'])('does not connect to the address %s', async host => {
    const { port, connections } = await serve((_req, res) => { res.end('{}') })
    await expect(guardedFetch({ ca: cert })(`https://${host}:${port}/`)).rejects.toThrow('Address refused')
    expect(connections).toEqual([])
  })
  it('does not connect to a name that leads to private addresses, and prefers the public ones of several', async () => {
    const { port, connections } = await serve((_req, res) => { res.end('{}') })
    for (const addresses of [['127.0.0.1'], ['10.0.0.1', '::1'], [], ['not an address']]) {
      await expect(guardedFetch({ resolve: async () => addresses, ca: cert })(`https://homeserver.test:${port}/`)).rejects.toThrow('No address')
    }
    expect(connections).toEqual([])
    const mixed = guardedFetch({ allows: loopback, resolve: async () => ['10.255.255.1', '127.0.0.1'], ca: cert })
    expect((await mixed(`https://homeserver.test:${port}/`)).status).toBe(200)
  })
  it('resolves real names through DNS alone', async () => {
    const { port, connections } = await serve((_req, res) => { res.end('{}') })
    // In /etc/hosts; no DNS server answers it with a public address.
    await expect(guardedFetch({ ca: cert })(`https://localhost:${port}/`)).rejects.toThrow('No address')
    expect(connections).toEqual([])
  }, 15_000)
  it('judges each connection anew after DNS changed its answer', async () => {
    const { port, connections } = await serve((_req, res) => { res.writeHead(200, { Connection: 'close' }).end('{}') })
    const answers = [['127.0.0.1'], ['10.0.0.1'], ['127.0.0.1']]
    const fetchImpl = guardedFetch({ allows: loopback, resolve: async () => answers.shift()!, ca: cert })
    const go = async () => (await requestJson(new URL(`https://homeserver.test:${port}/`), { method: 'GET' }, fetchImpl))
    expect(await go()).toEqual({})
    await expect(go()).rejects.toMatchObject({ transient: true })
    expect(connections).toHaveLength(1)
    expect(await go()).toEqual({})
  })
  it('gives up the connection whose own address is refused, before anything is asked', async () => {
    const requests = vi.fn()
    const { port, connections } = await serve((_req, res) => { requests(); res.end('{}') })
    let lookups = true
    // The answer passes when it is looked at and not once connected, as behind a resolver that lies.
    const fetchImpl = guardedFetch({ allows: address => { const was = lookups; lookups = false; return was && address === '127.0.0.1' }, resolve: async () => ['127.0.0.1'], ca: cert })
    await expect(fetchImpl(`https://homeserver.test:${port}/`)).rejects.toThrow('Address refused')
    expect(connections).toHaveLength(1)
    expect(requests).not.toHaveBeenCalled()
  })
  it('follows no redirect', async () => {
    const visited: string[] = []
    const { port } = await serve((req, res) => { visited.push(req.url!); res.writeHead(302, { Location: `https://other.test:${port}/elsewhere` }).end() })
    const fetchImpl = guardedFetch({ allows: loopback, resolve: async () => ['127.0.0.1'], ca: cert })
    await expect(requestJson(new URL(`https://homeserver.test:${port}/`), { method: 'GET' }, fetchImpl)).rejects.toBeInstanceOf(HttpError)
    await expect(fetchImpl(`https://homeserver.test:${port}/`)).rejects.toThrow('Unexpected answer')
    expect(visited).toEqual(['/', '/'])
  })
  it('refuses another name\'s certificate and one nobody signed', async () => {
    const { port } = await serve((_req, res) => { res.end('{}') })
    const at = { allows: loopback, resolve: async () => ['127.0.0.1'] }
    await expect(guardedFetch({ ...at, ca: cert })(`https://elsewhere.test:${port}/`)).rejects.toThrow(/altnames/i)
    await expect(guardedFetch(at)(`https://homeserver.test:${port}/`)).rejects.toThrow(/self[- ]signed/i)
  })
  it('ends a request that hangs, before the answer and in its middle, and leaves no connection behind', async () => {
    const closed = vi.fn()
    const { port } = await serve((req, res) => {
      req.socket.once('close', closed)
      if (req.url === '/half') res.writeHead(200, { 'Content-Type': 'application/json' }).write('{"a":')
    })
    const fetchImpl = guardedFetch({ allows: loopback, resolve: async () => ['127.0.0.1'], ca: cert })
    for (const path of ['never', 'half']) {
      await expect(requestJson(new URL(`https://homeserver.test:${port}/${path}`), { method: 'GET' }, fetchImpl, 150)).rejects.toMatchObject({ transient: true })
    }
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(2))
  })
  it('ends one whose server never speaks TLS, and one whose name never resolves', async () => {
    const silent = createTcpServer(() => {})
    await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve))
    const port = (silent.address() as AddressInfo).port
    const at = { allows: loopback, ca: cert }
    await expect(requestJson(new URL(`https://homeserver.test:${port}/`), { method: 'GET' }, guardedFetch({ ...at, resolve: async () => ['127.0.0.1'] }), 150)).rejects.toMatchObject({ transient: true })
    await expect(requestJson(new URL(`https://homeserver.test:${port}/`), { method: 'GET' }, guardedFetch({ ...at, resolve: () => new Promise(() => {}) }), 150)).rejects.toMatchObject({ transient: true })
    silent.close()
  })
  it('stops reading an answer that is too long', async () => {
    const closed = vi.fn()
    const { port } = await serve((req, res) => {
      req.socket.once('close', closed)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      const more = () => { while (!res.destroyed && res.write('x'.repeat(65_536))); res.once('drain', more) }
      more()
    })
    const fetchImpl = guardedFetch({ allows: loopback, resolve: async () => ['127.0.0.1'], ca: cert })
    await expect(requestJson(new URL(`https://homeserver.test:${port}/`), { method: 'GET' }, fetchImpl)).rejects.toThrow('exceeds limit')
    await vi.waitFor(() => expect(closed).toHaveBeenCalled())
  })
  it('finds the homeserver through .well-known, and refuses where that leads', async () => {
    const { port, connections } = await serve((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(req.url === '/.well-known/matrix/client'
        ? JSON.stringify({ 'm.homeserver': { base_url: req.headers.host!.startsWith('homeserver.test') ? `https://other.test:${port}` : 'https://10.0.0.1' } })
        : JSON.stringify({ user_id: '@me:homeserver.test' }))
    })
    const fetchImpl = guardedFetch({ allows: loopback, resolve: async () => ['127.0.0.1'], ca: cert })
    expect(await discoverHomeserver(`https://homeserver.test:${port}`, fetchImpl)).toBe(`https://other.test:${port}`)
    expect(await new MatrixClient({ homeserverUrl: `https://other.test:${port}`, asToken: 't', botUserId: '', account: true, fetchImpl }).whoami()).toBe('@me:homeserver.test')
    const inside = await discoverHomeserver(`https://other.test:${port}`, fetchImpl)
    expect(inside).toBe('https://10.0.0.1')
    const before = connections.length
    await expect(new MatrixClient({ homeserverUrl: inside, asToken: 't', botUserId: '', account: true, fetchImpl }).whoami()).rejects.toMatchObject({ transient: true })
    expect(connections).toHaveLength(before)
  })
  it('gives up the address rule alone where the operator allows it', async () => {
    const { port, connections } = await serve((_req, res) => { res.end('{}') })
    // Reached, and refused for its certificate.
    await expect(homeserverFetch(true)(`https://127.0.0.1:${port}/`)).rejects.toThrow(/self[- ]signed/i)
    await expect(homeserverFetch(true)(`https://localhost:${port}/`)).rejects.toThrow(/self[- ]signed|altnames/i)
    expect(connections.length).toBeGreaterThanOrEqual(2)
    await expect(homeserverFetch(true)(`http://127.0.0.1:${port}/`)).rejects.toThrow('Address refused')
    await expect(homeserverFetch(false)(`https://127.0.0.1:${port}/`)).rejects.toThrow('Address refused')
  })
})
