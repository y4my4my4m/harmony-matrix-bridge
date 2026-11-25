import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'

const servers: Server[] = []
const children: ChildProcess[] = []
const directories: string[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit').catch(() => {})
    }
  }
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
async function listen(server: Server): Promise<number> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as AddressInfo).port
}

it.each([{ platform: 'matrix', mode: 'relay', lists: true }, { platform: 'matrix', mode: 'ghost', lists: true }, { platform: 'matrix', mode: 'ghost', lists: false },
  { platform: 'matrix', mode: 'ghost', lists: true, taken: true }, { platform: null, mode: 'relay', lists: true }, { platform: 'discord', mode: 'relay', lists: true }, { platform: 'unavailable', mode: 'relay', lists: true }])('runs with verified Matrix registration and DB sender mode ($platform/$mode, lists: $lists, taken: $taken)', async ({ platform, mode, lists, taken }) => {
  const channelId = '22222222-2222-4222-8222-222222222222'
  const userId = '11111111-1111-4111-8111-111111111111'
  const harmonyPosts: unknown[] = []
  const matrixPosts: unknown[] = []
  const matrixSenders: string[] = []
  const memberFrames: unknown[] = []
  const privacyCalls: string[] = []
  let gateway: WebSocket | undefined
  const remote = createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    let result: unknown
    let status = 200
    if (path.endsWith('/bridge-platform')) {
      result = { platform }; if (platform === 'unavailable') status = 503
    }
    else if (path.startsWith('/bot-gateway/bridge/v2/matrix/privacy/')) {
      privacyCalls.push(`${req.method} ${decodeURIComponent(req.url!.slice('/bot-gateway/bridge/v2/matrix/privacy/'.length))}`)
      result = req.method === 'PUT' ? { opted_out: true, since: null, source: 'user' } : { version: '1', remote_user_ids: [] }
    }
    else if (path.endsWith('/bridge-room')) result = { room_id: '!room:test', sender_mode: mode }
    else if (path.endsWith('/bridge-members')) result = [{ id: userId, username: 'Alice', display_name: 'Alice', avatar_url: null, domain: 'test' }]
    else if (path.endsWith('/joined_members')) result = { joined: { '@alice:test': { display_name: 'Room Alice' } } }
    else if (path.includes('/bridge-consent/')) result = { relay_allowed: true }
    else if (path.includes('/state/m.room.member/')) result = { membership: 'join', displayname: 'Room Alice' }
    else if (path.endsWith('/encryption')) result = { messages_encrypted: false }
    else if (path.endsWith('/state/m.room.encryption/')) { result = { errcode: 'M_NOT_FOUND' }; status = 404 }
    else if (path.endsWith('/register') && taken && input.username.includes('_h_')) { result = { errcode: 'M_USER_IN_USE' }; status = 400 }
    else if (path.endsWith('/register')) result = { user_id: `@${input.username}:test` }
    else if (path.endsWith('/account/whoami')) result = { user_id: new URL(req.url!, 'http://localhost').searchParams.get('user_id') }
    else if (path.includes('/join/')) result = { room_id: '!room:test' }
    else if (path.endsWith('/messages')) { harmonyPosts.push(input); result = { id: 'h-copy' } }
    else if (path.includes('/send/')) { matrixPosts.push(input); matrixSenders.push(new URL(req.url!, 'http://localhost').searchParams.get('user_id')!); result = { event_id: '$m-copy' } }
    else { status = 404; result = {} }
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
  })
  const sockets = new WebSocketServer({ server: remote })
  sockets.on('connection', socket => {
    gateway = socket
    socket.on('message', bytes => {
      const frame = JSON.parse(bytes.toString())
      if (frame.op === 2) socket.send(JSON.stringify({ op: 0, t: 'READY', d: { heartbeat_interval: 1000, capabilities: lists ? [] : ['matrix_bridge_v2'] } }))
      if (frame.op === 1) socket.send('{"op":11}')
      if (frame.op === 6) memberFrames.push(frame.d)
    })
  })
  const port = await listen(remote)
  // Reserve/release a loopback port for the child. No services are exposed outside localhost.
  const reservation = createServer()
  const relayPort = await listen(reservation)
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const directory = mkdtempSync(join(tmpdir(), 'matrix-service-test-'))
  directories.push(directory)
  const configPath = join(directory, 'config.json')
  writeFileSync(configPath, JSON.stringify({
    harmony: { apiUrl: `http://127.0.0.1:${port}/bot-gateway`, gatewayUrl: `ws://127.0.0.1:${port}/gateway`, ...(lists ? { allowedUserIds: [userId] } : {}) },
    matrix: { homeserverUrl: `http://127.0.0.1:${port}`, serverName: 'test', applicationServiceUrl: `http://127.0.0.1:${relayPort}`, ...(lists ? { allowedUserIds: ['@alice:test'] } : {}) },
    listen: { host: '127.0.0.1', port: relayPort }, database: join(directory, 'bridge.sqlite'),
    pairs: [{ harmonyChannelId: channelId, matrixRoomId: '!room:test' }],
  }), { mode: 0o600 })
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MATRIX_BRIDGE_CONFIG: configPath, HARMONY_TOKEN: `harmony_bot_${'a'.repeat(64)}`, MATRIX_AS_TOKEN: 'b'.repeat(64), MATRIX_HS_TOKEN: 'c'.repeat(64) },
  })
  children.push(child)
  let output = ''
  child.stdout!.on('data', chunk => { output += String(chunk) })
  child.stderr!.on('data', chunk => { output += String(chunk) })
  if (platform !== 'matrix') {
    await vi.waitFor(() => expect(child.exitCode).toBe(1), { timeout: 10_000 })
    expect(output).toContain('Server settings, Bridges, Matrix')
    expect(output).not.toContain('Harmony gateway connected')
    expect(matrixPosts).toHaveLength(0)
    expect(harmonyPosts).toHaveLength(0)
    sockets.close()
    return
  }
  await vi.waitFor(() => {
    expect(child.exitCode, output).toBeNull()
    expect(output).toContain('Harmony gateway connected')
  }, { timeout: 10_000 })
  gateway!.send(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', d: {
    id: 'h-one', channel_id: channelId, author: { id: userId, username: 'Alice' },
    content: 'hello Matrix', content_raw: [{ type: 'text', text: 'hello Matrix' }], metadata: {}, is_system: false,
  } }))
  if (taken) {
    // With a hand-written configuration a Matrix user found under a ghost's name is nobody's to take.
    await vi.waitFor(() => expect(output).toContain('Delivery failed'), { timeout: 5000 })
    expect(matrixPosts).toEqual([])
    sockets.close()
    return
  }
  const transaction = JSON.stringify({ events: [{ type: 'm.room.message', room_id: '!room:test', event_id: '$one', sender: '@alice:test', content: { msgtype: 'm.text', body: 'hello Harmony' } }] })
  const send = () => fetch(`http://127.0.0.1:${relayPort}/_matrix/app/v1/transactions/one`, {
    method: 'PUT', headers: { Authorization: `Bearer ${'c'.repeat(64)}` }, body: transaction,
  })
  expect((await send()).status).toBe(200)
  expect((await send()).status).toBe(200)
  await vi.waitFor(() => {
    expect(harmonyPosts).toHaveLength(1)
    expect(matrixPosts).toHaveLength(1)
  }, { timeout: 5000 })
  expect(matrixPosts[0]).toMatchObject({ body: mode === 'ghost' ? 'hello Matrix' : '[Alice · Harmony] hello Matrix', 'm.mentions': {} })
  expect(matrixSenders[0]).toBe(mode === 'ghost' ? '@harmony_relay_h_11111111111141118111111111111111:test' : '@harmony_relay:test')
  await vi.waitFor(() => expect(memberFrames).toContainEqual({ platform: 'matrix', channels: [{ harmonyChannelId: channelId, members: [{ id: '@alice:test', username: 'alice', displayName: 'Room Alice', avatarUrl: null, source: 'matrix' }] }] }))
  expect(harmonyPosts[0]).toMatchObject({ content: [{ type: 'text', text: 'hello Harmony' }],
    metadata: { bridge_author: { platform: 'matrix', id: '@alice:test', username: 'alice', display_name: 'Room Alice' } } })
  // Without HARMONY_URL the privacy routes are asked per channel, and only of a Harmony that has them.
  const ask = () => fetch(`http://127.0.0.1:${relayPort}/_matrix/app/v1/transactions/ask`, {
    method: 'PUT', headers: { Authorization: `Bearer ${'c'.repeat(64)}` },
    body: JSON.stringify({ events: [{ type: 'm.room.message', room_id: '!room:test', event_id: '$ask', sender: '@alice:test', content: { msgtype: 'm.text', body: '!bridge-privacy opt-out' } }] }),
  })
  expect((await ask()).status).toBe(200)
  await vi.waitFor(() => expect(matrixPosts).toHaveLength(2), { timeout: 5000 })
  expect(matrixPosts[1]).toMatchObject({ msgtype: 'm.notice', body: expect.stringContaining(lists ? 'does not offer that yet' : 'You are opted out') })
  expect(matrixSenders[1]).toBe('@harmony_relay:test')
  expect(privacyCalls.filter(call => call.startsWith('PUT'))).toEqual(lists ? [] : [`PUT optouts/@alice:test?channel_id=${channelId}`])
  if (!lists) await vi.waitFor(() => expect(privacyCalls).toContain(`GET optouts?channel_id=${channelId}`), { timeout: 3000 })
  expect(harmonyPosts).toHaveLength(1)
  expect(output).not.toContain('hello Matrix')
  expect(output).not.toContain('b'.repeat(64))
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  expect((await exited)[0]).toBe(0)
  sockets.close()
}, 20_000)
