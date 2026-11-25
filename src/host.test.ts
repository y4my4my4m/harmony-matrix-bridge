import { once } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inside } from './Boundary.js'
import { BridgeHost, type BridgeHostOptions, type HostTimings } from './BridgeHost.js'
import type { StatusReport } from './BridgeApi.js'
import type { HostStatus } from './HostApi.js'
import { MAX_WAITING_ROOMS } from './InstanceHost.js'
import { QuotaError, Store } from './Store.js'

const userId = '11111111-1111-4111-8111-111111111111'
const otherUser = '55555555-5555-4555-8555-555555555555'
const ghostOf = (id: string) => `@harmony_relay_h_${id.replaceAll('-', '')}:test`
const ghost = ghostOf(userId)
const bot = '@harmony_relay:test'
const account = '@instance:test'
const alice = '@alice:test'
const bridgeId = (name: string) => `${name.charCodeAt(0).toString(16).repeat(4)}-1111-4111-8111-111111111111`
const channelOf = (name: string) => `22222222-2222-4222-8222-${name.charCodeAt(0).toString(16).padStart(12, '0')}`
const tokenOf = (name: string) => `harmony_bot_${name}_secret`
const secret = 'host-secret-0123456789-0123456789-x'
const asToken = 'as'.repeat(20)
const hsToken = 'hs'.repeat(20)
const accessToken = 'syt_instance_secret'

vi.setConfig({ testTimeout: 20_000 })
const servers: Server[] = []
const hosts: BridgeHost[] = []
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(hosts.splice(0).map(host => host.stop()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
async function listen(server: Server): Promise<number> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as AddressInfo).port
}
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'matrix-host-test-'))
  directories.push(path)
  return path
}
const eventually = (check: () => void | Promise<void>, timeout = 8_000) => vi.waitFor(check, { timeout, interval: 15 })
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

interface FakeBridge {
  name: string; token: string; pairs: Array<Record<string, any>>; optedOut: string[]; privacyVersion: string; matrixOptedOut: string[]; configs: number; statuses: StatusReport[]
  posts: any[]; sockets: number; socket?: WebSocket; configDelay?: Promise<void>; configStatus: number; members: string[]
}
const pair = (name: string, room: string, extra: Record<string, unknown> = {}) => ({ channel_id: channelOf(name), channel_name: name, room_id: room, room_alias: null, direction: 'both', sender_mode: 'ghost', encrypted: false, ...extra })

/** bot-gateway with several bridges' bots and its host routes, and a homeserver with an application service and an account. */
async function world() {
  const bridges = new Map<string, FakeBridge>()
  const addBridge = (name: string, pairs: Array<Record<string, any>> = []): FakeBridge => {
    const bridge: FakeBridge = { name, token: tokenOf(name), pairs, optedOut: [], privacyVersion: '1', matrixOptedOut: [], configs: 0, statuses: [], posts: [], sockets: 0, configStatus: 200, members: [userId] }
    bridges.set(name, bridge)
    return bridge
  }
  const state = {
    connection: 'application_service' as 'application_service' | 'account', instance: true, listed: [] as string[], hosted: [] as Array<Record<string, unknown>>, listStatus: 200, hostStatuses: [] as HostStatus[],
    links: [] as any[], linkAnswer: null as null | { status: number; body: unknown }, codes: new Map<string, { name: string; channel: string }>(),
    refuseMatrix: false, joins: [] as string[], leaves: [] as string[], reasons: [] as string[], registers: [] as string[], posts: [] as any[], membership: new Map<string, string>(), encrypted: new Set<string>(),
    power: new Map<string, any>(), queue: [] as Array<{ room?: string; events?: unknown[]; invite?: string; state?: unknown[] }>, pendingSync: null as null | { res: ServerResponse; since: number }, filters: [] as any[],
    asToken, accessToken, hsToken, whoami: account, onJoin: new Map<string, () => void>(), aliases: [] as string[],
  }
  const answerSync = () => {
    const pending = state.pendingSync
    if (!pending) return
    state.pendingSync = null
    const joined: Record<string, any> = {}
    const invite: Record<string, any> = {}
    for (const entry of state.queue.slice(pending.since)) {
      if (entry.invite) invite[entry.invite] = { invite_state: { events: entry.state ?? [] } }
      else {
        if (!(state.filters.at(-1)?.room.rooms as string[]).includes(entry.room!)) continue
        joined[entry.room!] ??= { timeline: { events: [], limited: false, prev_batch: 'p' }, state: { events: [] } }
        joined[entry.room!].timeline.events.push(...entry.events!)
      }
    }
    pending.res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ next_batch: `s${state.queue.length}`, rooms: { join: joined, invite } }))
  }
  const remote = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost')
    const path = decodeURIComponent(url.pathname)
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    const send = (result: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(result)) }
    if (path === '/bot-gateway/health') return send({ status: 'ok' })
    if (path.startsWith('/bot-gateway/bridge/v2/matrix/host')) {
      if (req.headers['x-bridge-host-secret'] !== secret) return send({}, 401)
      const route = path.slice('/bot-gateway/bridge/v2/matrix/host'.length)
      if (route === '/status') { state.hostStatuses.push(input); return send({ ok: true }) }
      if (route === '/link') {
        state.links.push(input)
        if (state.linkAnswer) return send(state.linkAnswer.body, state.linkAnswer.status)
        const code = state.codes.get(input.code)
        if (!code) return send({ code: 'invalid_code' }, 400)
        state.codes.delete(input.code)
        for (const bridge of bridges.values()) for (const row of bridge.pairs) if (row.room_id === input.room_id) row.room_id = null
        const bridge = bridges.get(code.name)!
        bridge.pairs = [...bridge.pairs.filter(row => row.channel_id !== code.channel), pair(code.name, input.room_id)]
        return send({ bridge_id: bridgeId(code.name), server_name: `Server ${code.name}`, channel_id: code.channel, channel_name: `channel-${code.name}` })
      }
      if (state.listStatus !== 200) return send({}, state.listStatus)
      return send({ hosted: state.hosted, instance: state.instance ? { connection: state.connection, homeserver_url: `http://127.0.0.1:${port}`,
        server_name: state.connection === 'account' ? null : 'test', sender_localpart: state.connection === 'account' ? null : 'harmony_relay',
        as_token: state.connection === 'account' ? null : state.asToken, hs_token: state.connection === 'account' ? null : state.hsToken, access_token: state.connection === 'account' ? state.accessToken : null,
        bridges: state.listed.map(name => ({ bridge_id: bridgeId(name), harmony_token: bridges.get(name)!.token })) } : null })
    }
    if (path.startsWith('/bot-gateway/')) {
      const bridge = [...bridges.values()].find(candidate => req.headers.authorization === `Bot ${candidate.token}`)
      if (!bridge) return send({}, 401)
      const route = path.slice('/bot-gateway/'.length)
      const paired = bridge.pairs.find(row => route.includes(row.channel_id))
      const member = (id: string) => ({ id, username: id.slice(0, 4), display_name: `Member ${id.slice(0, 4)}`, avatar_url: null, domain: 'test' })
      const eligible = bridge.members.filter(id => !bridge.optedOut.includes(id))
      if (route.endsWith('/bridge-check')) {
        const asked = url.searchParams.get('user_id')
        return send(!paired ? { platform: null, room_id: null, sender_mode: null, messages_encrypted: null, relay_allowed: null, member: null }
          : { platform: 'matrix', room_id: paired.room_id, sender_mode: paired.sender_mode, messages_encrypted: false, relay_allowed: asked === null ? null : !bridge.optedOut.includes(asked),
            member: asked !== null && eligible.includes(asked) ? member(asked) : null })
      }
      if (route === 'bridge/v2/matrix/config') {
        bridge.configs++
        await bridge.configDelay
        return bridge.configStatus === 200 ? send({ bridge_id: bridgeId(bridge.name), server_id: `s-${bridge.name}`, mode: 'instance', updated_at: JSON.stringify([bridge.pairs, bridge.optedOut]), base_url: null,
          privacy_version: bridge.privacyVersion, pairs: bridge.pairs }) : send({}, bridge.configStatus)
      }
      if (route === 'bridge/v2/matrix/status') { bridge.statuses.push(input); return send({ ok: true }) }
      if (route.endsWith('/privacy/optouts')) return send({ version: bridge.privacyVersion, remote_user_ids: bridge.matrixOptedOut })
      if (route.endsWith('/bridge-room')) return req.method === 'PUT' ? send({ code: 'room_in_use' }, 409) : send({ room_id: paired?.room_id ?? null, sender_mode: 'ghost' })
      if (route.endsWith('/bridge-members')) return send(eligible.map(member))
      if (route.endsWith('/messages')) { bridge.posts.push(input); return send({ id: `h-${bridge.name}-${bridge.posts.length}` }) }
      return send({}, 404)
    }
    const bearer = req.headers.authorization
    if (state.refuseMatrix || (bearer !== `Bearer ${state.asToken}` && bearer !== `Bearer ${state.accessToken}`)) return send({ errcode: 'M_UNKNOWN_TOKEN' }, 401)
    const self = url.searchParams.get('user_id') ?? state.whoami
    const room = /\/rooms\/([^/]+)\//.exec(path)?.[1] ?? ''
    if (path.endsWith('/register')) { state.registers.push(input.username); return send({ user_id: `@${input.username}:test` }) }
    if (path.endsWith('/account/whoami')) return send({ user_id: self })
    if (path.includes('/v3/join/')) {
      const target = path.split('/v3/join/')[1]
      if (target.startsWith('!gone')) return send({ errcode: 'M_FORBIDDEN' }, 403)
      if (target.startsWith('!hangs')) return
      state.joins.push(`${target} ${self}`)
      state.membership.set(`${target} ${self}`, 'join')
      state.onJoin.get(target)?.()
      return send({ room_id: target })
    }
    if (path.endsWith('/leave')) { state.leaves.push(`${room} ${self}`); if (input.reason) state.reasons.push(input.reason); state.membership.delete(`${room} ${self}`); return send({}) }
    if (path.endsWith('/invite')) return send({})
    if (path.includes('/directory/room/')) { state.aliases.push(path); return send({ room_id: '!z:test', servers: [] }) }
    if (path.endsWith('/joined_members')) return send({ joined: { [alice]: { display_name: 'Room Alice' } } })
    if (path.includes('/state/m.room.member/')) {
      const member = path.split('/state/m.room.member/')[1]
      if (req.method === 'PUT') { state.membership.set(`${room} ${member}`, 'join'); return send({ event_id: '$member' }) }
      if (member === alice || member === '@bob:test') return send({ membership: 'join', displayname: 'Room Alice' })
      const membership = state.membership.get(`${room} ${member}`)
      return membership ? send({ membership }) : send({ errcode: 'M_NOT_FOUND' }, 404)
    }
    if (path.endsWith('/state/m.room.encryption/')) return state.encrypted.has(room) ? send({ algorithm: 'm.megolm.v1.aes-sha2' }) : send({ errcode: 'M_NOT_FOUND' }, 404)
    if (path.endsWith('/state/m.room.power_levels/')) return send(state.power.get(room) ?? { users: { [alice]: 100, [bot]: 50, [account]: 50 } })
    if (path.includes('/state/m.room.create/')) return send({ sender: '@owner:test', content: { room_version: '11' } })
    if (path.endsWith('/state/m.room.name/')) return send({ name: `Name of ${room}` })
    if (path.includes('/state/')) return send({ errcode: 'M_NOT_FOUND' }, 404)
    if (path.includes('/send/')) {
      const transaction = path.split('/').at(-1)
      if (!state.posts.some(post => post.transaction === transaction && post.sender === self)) state.posts.push({ ...input, sender: self, room, transaction })
      return send({ event_id: `$m${state.posts.length}` })
    }
    if (path.endsWith('/filter')) { state.filters.push(input); return send({ filter_id: `f${state.filters.length}` }) }
    if (path.endsWith('/sync')) {
      const since = Number(url.searchParams.get('since')?.slice(1) ?? 0)
      state.pendingSync = { res, since }
      res.on('close', () => { if (state.pendingSync?.res === res) state.pendingSync = null })
      if (url.searchParams.get('timeout') === '0' || state.queue.length > since) answerSync()
      return
    }
    return send({}, 404)
  })
  const sockets = new WebSocketServer({ server: remote })
  sockets.on('connection', socket => {
    socket.on('message', bytes => {
      const frame = JSON.parse(bytes.toString())
      if (frame.op !== 2) return
      const bridge = [...bridges.values()].find(candidate => candidate.token === frame.d.token)
      if (!bridge) return socket.close(4004, 'Invalid token')
      bridge.sockets++
      bridge.socket = socket
      socket.send(JSON.stringify({ op: 0, t: 'READY', d: { heartbeat_interval: 60_000, capabilities: ['matrix_bridge_v2', 'matrix_bridge_check'] } }))
    })
  })
  const port = await listen(remote)
  let serial = 0
  return {
    state, bridges, addBridge, port, url: `http://127.0.0.1:${port}`,
    configChanged: (name: string) => bridges.get(name)!.socket!.send(JSON.stringify({ op: 0, t: 'BRIDGE_CONFIG_UPDATE', d: { bridge_id: bridgeId(name) } })),
    harmony: (name: string, text: string, author = userId) => bridges.get(name)!.socket!.send(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', d: { id: `n-${name}-${serial++}`, channel_id: channelOf(name),
      author: { id: author, username: 'Alice' }, content: text, content_raw: [{ type: 'text', text }], metadata: {}, is_system: false } })),
    sync: (...entries: Array<{ room?: string; events?: unknown[]; invite?: string; state?: unknown[] }>) => { state.queue.push(...entries); answerSync() },
    texts: (name: string) => bridges.get(name)!.posts.map(post => post.content[0].text),
    said: (room: string) => state.posts.filter(post => post.room === room).map(post => post.body),
  }
}
type World = Awaited<ReturnType<typeof world>>

let serial = 0
const message = (room: string, body: string, extra: Record<string, unknown> = {}) => ({ type: 'm.room.message', event_id: `$e${serial++}`, room_id: room, sender: alice, origin_server_ts: Date.now(), content: { msgtype: 'm.text', body }, ...extra })
const invite = (room: string, state: unknown[] = [], user = bot) => ({ type: 'm.room.member', event_id: `$i${serial++}`, room_id: room, sender: alice, state_key: user, content: { membership: 'invite' }, unsigned: { invite_room_state: state } })

const FAST: Partial<HostTimings> = { configMs: 60_000, configSoonMs: 5, statusMs: 60_000, statusSoonMs: 5, roomsMs: 50, memberFrameMs: 20, matrixMs: 200, backoffMs: 30, linkMs: 600, sweepMs: 40, holdMs: 1_500, restartMs: 60,
  pollMs: 60_000, hostStatusMs: 50, hostedHealthMs: 30 }

async function start(w: World, options: { dataDir?: string; timings?: Partial<HostTimings>; secret?: string } & Partial<BridgeHostOptions> = {}) {
  const dataDir = options.dataDir ?? directory()
  const lines: string[] = []
  const host = new BridgeHost({ kind: 'host', harmonyUrl: w.url, publicUrl: 'https://harmony.test', secret: options.secret ?? secret, dataDir, listen: { host: '127.0.0.1', port: 0 }, anyAddress: false },
    { version: '1.0.0-test', log: line => lines.push(line), warn: line => lines.push(line), timings: { ...FAST, ...options.timings }, workerUrl: options.workerUrl, hosted: options.hosted })
  hosts.push(host)
  await host.start()
  const port = ((host as unknown as { server: Server }).server.address() as AddressInfo).port
  const transaction = async (id: string, events: unknown[], token = w.state.hsToken) => (await fetch(`http://127.0.0.1:${port}/_matrix/app/v1/transactions/${id}`,
    { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ events }) })).status
  const health = async () => { const response = await fetch(`http://127.0.0.1:${port}/health`); return { status: response.status, body: await response.json() as any } }
  return { host, lines, dataDir, port, transaction, health }
}
/** Two servers on one connection, their pairs ready. */
async function pairedWorld(options: Parameters<typeof start>[1] = {}, connection: 'application_service' | 'account' = 'application_service', membersOfA = [userId]) {
  const w = await world()
  w.state.connection = connection
  w.addBridge('a', [pair('a', '!a:test')]).members = membersOfA
  w.addBridge('b', [pair('b', '!b:test')])
  w.state.listed = ['a', 'b']
  const running = await start(w, options)
  await ready(w, 'a', 'b')
  return { w, ...running }
}
async function ready(w: World, ...names: string[]) {
  for (const name of names) await eventually(() => expect(w.bridges.get(name)!.statuses.at(-1)?.pairs).toEqual([{ channel_id: channelOf(name), state: 'ready', error: null }]))
}
const inner = (host: BridgeHost) => (host as unknown as { instance: { host: any } }).instance.host
const slotOf = (host: BridgeHost, name: string) => inner(host).slots.get(bridgeId(name))

describe('the instance\'s connection', () => {
  it('carries each room to its own server and back, and reports', async () => {
    const { w, transaction, health, lines, dataDir, host } = await pairedWorld()
    expect(await transaction('t1', [message('!a:test', 'to a'), message('!b:test', 'to b'), message('!elsewhere:test', 'nobody')])).toBe(200)
    await eventually(() => expect([w.texts('a'), w.texts('b')]).toEqual([['to a'], ['to b']]))
    w.harmony('a', 'from a')
    w.harmony('b', 'from b')
    await eventually(() => expect(w.state.posts).toHaveLength(2))
    expect(w.state.posts.map(post => [post.room, post.sender, post.body]).sort()).toEqual([['!a:test', ghost, 'from a'], ['!b:test', ghost, 'from b']])
    // One Matrix user for a person both servers have.
    expect(w.state.registers.filter(name => name === ghost.slice(1, ghost.indexOf(':')))).toHaveLength(1)
    await eventually(() => expect(w.bridges.get('a')!.statuses.at(-1)!.rooms.map(room => room.room_id)).toEqual(['!a:test']))
    expect(w.bridges.get('b')!.statuses.at(-1)).toMatchObject({ connection: 'application_service', ready: true, user_id: bot, server_name: 'test', homeserver: 'https://test', version: '1.0.0-test', problems: [] })
    await eventually(() => expect(w.state.hostStatuses.at(-1)).toEqual({ version: '1.0.0-test', instance: { ready: true, user_id: bot, server_name: 'test', problems: [] }, hosted: 0 }))
    expect(await health()).toEqual({ status: 200, body: { ready: true, mode: 'host', hosted: 0, hosted_ready: 0, instance: { ready: true, problems: [] } } })
    expect(statSync(join(dataDir, 'instance', bridgeId('a'))).mode & 0o777).toBe(0o700)
    expect(statSync(join(dataDir, 'instance', bridgeId('a'), 'bridge.sqlite')).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(dataDir, 'instance')).filter(name => name.endsWith('.sqlite'))).toHaveLength(1)
    await host.stop()
    expect(lines).toEqual(expect.arrayContaining(['Bridge list read: 0 hosted, 2 on the instance\'s connection', '[instance] Matrix homeserver connected', '[61616161] Pair ready']))
    for (const hidden of ['secret', asToken, hsToken, 'to a', 'from a', alice, ghost, '!a:test']) expect(lines.join('\n')).not.toContain(hidden)
  })
  it('keeps one server\'s opt-out to that server', async () => {
    const { w } = await pairedWorld()
    await eventually(() => expect([w.state.membership.get(`!a:test ${ghost}`), w.state.membership.get(`!b:test ${ghost}`)]).toEqual(['join', 'join']))
    w.bridges.get('a')!.optedOut = [userId]
    w.harmony('a', 'silent')
    w.harmony('b', 'heard')
    await eventually(() => expect(w.said('!b:test')).toEqual(['heard']))
    expect(w.said('!a:test')).toEqual([])
    // Reading the opt-outs of Matrix people anew refreshes the members too.
    w.bridges.get('a')!.privacyVersion = '2'
    w.bridges.get('a')!.matrixOptedOut = ['@x:test']
    w.configChanged('a')
    await eventually(() => expect(w.state.leaves).toContain(`!a:test ${ghost}`))
    expect(w.state.leaves).not.toContain(`!b:test ${ghost}`)
    w.harmony('b', 'still')
    await eventually(() => expect(w.said('!b:test')).toEqual(['heard', 'still']))
  })
  it('acknowledges a transaction when every bridge it concerns has stored its part, and repeats change nothing', async () => {
    const { w, transaction, host } = await pairedWorld()
    const accept = Store.prototype.acceptTransaction
    let failing = 1
    vi.spyOn(Store.prototype, 'acceptTransaction').mockImplementation(function (this: Store, id, jobs, fences) {
      if (jobs.some(job => job.channelId === channelOf('b')) && failing-- > 0) throw new Error('disk')
      return accept.call(this, id, jobs, fences)
    })
    const events = [message('!a:test', 'one'), message('!b:test', 'two')]
    expect(await transaction('t1', events)).toBe(503)
    const statuses: number[] = []
    await eventually(async () => { statuses.push(await transaction('t1', events)); expect(statuses.at(-1)).toBe(200) })
    await eventually(() => expect([w.texts('a'), w.texts('b')]).toEqual([['one'], ['two']]))
    expect(await transaction('t1', events)).toBe(200)
    expect(await transaction('t2', events)).toBe(200)
    await pause(200)
    expect([w.texts('a'), w.texts('b')]).toEqual([['one'], ['two']])
    expect(slotOf(host, 'b').skippedAt).toBeNull()
  })
  it('lets the others go on when one bridge fails on the same events again and again', async () => {
    const { w, transaction, lines } = await pairedWorld()
    const accept = Store.prototype.acceptTransaction
    vi.spyOn(Store.prototype, 'acceptTransaction').mockImplementation(function (this: Store, id, jobs, fences) {
      if (jobs.some(job => job.payload.body === 'poison')) throw new TypeError('secret detail')
      return accept.call(this, id, jobs, fences)
    })
    const events = [message('!a:test', 'one'), message('!b:test', 'poison')]
    let tries = 0
    await eventually(async () => { tries++; expect(await transaction('t1', events)).toBe(200) })
    expect(tries).toBeGreaterThanOrEqual(4)
    await eventually(() => expect(w.texts('a')).toEqual(['one']))
    const later = [message('!b:test', 'later')]
    await eventually(async () => expect(await transaction('t2', later)).toBe(200))
    await eventually(() => expect(w.texts('b')).toEqual(['later']))
    await eventually(() => expect(w.bridges.get('b')!.statuses.at(-1)!.problems).toEqual([{ code: 'messages_skipped', detail: expect.any(String) }]))
    expect(w.bridges.get('a')!.statuses.at(-1)!.problems).toEqual([])
    expect(lines.join('\n')).not.toContain('secret detail')
  })
  it('takes the fences and lets the messages go when a bridge\'s queue is full', async () => {
    const { w, transaction, host } = await pairedWorld()
    const accept = Store.prototype.acceptTransaction
    vi.spyOn(Store.prototype, 'acceptTransaction').mockImplementation(function (this: Store, id, jobs, fences) {
      if (jobs.some(job => job.channelId === channelOf('b'))) throw new QuotaError('full')
      return accept.call(this, id, jobs, fences)
    })
    expect(await transaction('t1', [message('!a:test', 'one'), message('!b:test', 'two'), { type: 'm.room.encryption', event_id: '$enc', room_id: '!b:test', sender: alice, state_key: '', content: {} }])).toBe(200)
    await eventually(() => expect(w.texts('a')).toEqual(['one']))
    expect(slotOf(host, 'b').store.isRoomBlocked('!b:test')).toBe(true)
    expect(w.bridges.get('b')!.sockets).toBe(1)
    await eventually(() => expect(w.bridges.get('b')!.statuses.at(-1)!.problems.map(problem => problem.code)).toEqual(expect.arrayContaining(['messages_skipped', 'room_encrypted'])))
  })
  it('holds events until every bridge\'s pairs are known, and no longer than a while', async () => {
    const w = await world()
    w.addBridge('a', [pair('a', '!a:test')])
    const slow = w.addBridge('b', [pair('b', '!b:test')])
    let release!: () => void
    slow.configDelay = new Promise(resolve => { release = resolve })
    w.state.listed = ['a', 'b']
    const { transaction } = await start(w, { timings: { holdMs: 60_000 } })
    await ready(w, 'a')
    expect(await transaction('t1', [message('!a:test', 'early'), message('!b:test', 'early')])).toBe(503)
    release()
    slow.configDelay = undefined
    await ready(w, 'b')
    expect(await transaction('t1', [message('!a:test', 'one'), message('!b:test', 'two')])).toBe(200)
    await eventually(() => expect([w.texts('a'), w.texts('b')]).toEqual([['one'], ['two']]))

    const other = await world()
    other.addBridge('a', [pair('a', '!a:test')])
    other.addBridge('b', [pair('b', '!b:test')]).configStatus = 401
    other.state.listed = ['a', 'b']
    const second = await start(other, { timings: { holdMs: 400 } })
    await ready(other, 'a')
    expect(await second.transaction('t1', [message('!a:test', 'one')])).toBe(503)
    await eventually(async () => expect(await second.transaction('t1', [message('!a:test', 'one')])).toBe(200))
    await eventually(() => expect(other.texts('a')).toEqual(['one']))
  })
  it('refuses a wrong token, and everything while it is off', async () => {
    const { w, transaction, host, port } = await pairedWorld()
    expect(await transaction('t1', [], 'wrong'.repeat(10))).toBe(401)
    expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(401)
    w.state.instance = false
    await host.poll()
    expect(await transaction('t1', [message('!a:test', 'off')])).toBe(503)
    expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404)
    expect(w.state.leaves).toEqual([])
    await eventually(() => expect(w.state.hostStatuses.at(-1)!.instance).toBeNull())
    w.state.instance = true
    await host.poll()
    await eventually(() => expect(w.bridges.get('a')!.sockets).toBe(2))
    await eventually(async () => expect(await transaction('t2', [message('!a:test', 'on')])).toBe(200))
    await eventually(() => expect(w.texts('a')).toEqual(['on']))
    await pause(400)
    expect(w.state.leaves.filter(left => left.endsWith(bot))).toEqual([])
  })
  it('says what keeps it from working', async () => {
    const { w, host } = await pairedWorld()
    w.state.refuseMatrix = true
    await eventually(() => expect(w.state.hostStatuses.at(-1)!.instance).toEqual({ ready: false, user_id: bot, server_name: 'test', problems: [{ code: 'matrix_registration_missing' }] }))
    await eventually(() => expect(w.bridges.get('a')!.statuses.at(-1)).toMatchObject({ ready: false, problems: [{ code: 'matrix_registration_missing' }] }))
    w.state.refuseMatrix = false
    await eventually(() => expect(w.state.hostStatuses.at(-1)!.instance!.ready).toBe(true))
    w.state.asToken = 'new'.repeat(12)
    await eventually(() => expect(w.state.hostStatuses.at(-1)!.instance!.ready).toBe(false))
    await host.poll()
    await eventually(() => expect(w.state.hostStatuses.at(-1)!.instance!.ready).toBe(true))
  })
})

describe('one bridge of several', () => {
  it('that throws where nothing catches it is restarted, alone', async () => {
    const { w, host, transaction, lines } = await pairedWorld()
    let caught!: unknown
    const listeners = process.listeners('uncaughtException')
    process.removeAllListeners('uncaughtException')
    process.once('uncaughtException', error => { caught = error })
    inside(bridgeId('b'), () => setTimeout(() => { throw new TypeError('secret detail') }, 1))
    await eventually(() => expect(caught).toBeInstanceOf(TypeError))
    for (const listener of listeners) process.on('uncaughtException', listener as never)
    expect(host.crashed(bridgeId('b'), caught)).toBe(true)
    expect(host.crashed(bridgeId('b'), caught)).toBe(true)
    expect(await transaction('t1', [message('!a:test', 'meanwhile')])).toBe(200)
    expect(await transaction('t2', [message('!b:test', 'held')])).toBe(503)
    await eventually(() => expect(w.texts('a')).toEqual(['meanwhile']))
    await eventually(() => expect(w.bridges.get('b')!.sockets).toBe(2))
    await eventually(async () => expect(await transaction('t2', [message('!b:test', 'held')])).toBe(200))
    await eventually(() => expect(w.texts('b')).toEqual(['held']))
    expect(w.bridges.get('a')!.sockets).toBe(1)
    expect(lines.filter(line => line.includes('stopped by an error'))).toEqual([expect.stringMatching(/^\[62626262\] Bridge stopped by an error; restarting in 0 s\. TypeError at /)])
    expect(lines.join('\n')).not.toContain('secret detail')
    // No bridge of this host: not its error to take.
    expect(host.crashed('someone else', caught)).toBe(false)
  })
  it('that could not write its database is restarted', async () => {
    const { w, host } = await pairedWorld()
    vi.spyOn(slotOf(host, 'b').store, 'complete').mockImplementation(() => { throw new Error('disk') })
    w.harmony('b', 'lost write')
    await eventually(() => expect(w.bridges.get('b')!.sockets).toBe(2))
    await ready(w, 'b')
    await eventually(() => expect(w.said('!b:test')).toEqual(['lost write']))
    expect(w.bridges.get('a')!.sockets).toBe(1)
  })
  it('that got new credentials is restarted, alone', async () => {
    const { w, host } = await pairedWorld()
    w.bridges.get('b')!.token = 'harmony_bot_renewed_secret'
    await host.poll()
    await eventually(() => expect(w.bridges.get('b')!.sockets).toBe(2))
    w.harmony('b', 'after')
    await eventually(() => expect(w.said('!b:test')).toEqual(['after']))
    expect(w.bridges.get('a')!.sockets).toBe(1)
    await host.poll()
    await pause(100)
    expect(w.bridges.get('b')!.sockets).toBe(2)
  })
  it('that is no longer listed stops and keeps its data; back in time it goes on as it was', async () => {
    const { w, host, transaction, dataDir } = await pairedWorld({ timings: { linkMs: 1_500 } })
    expect(await transaction('t1', [message('!b:test', 'one')])).toBe(200)
    await eventually(() => expect(w.texts('b')).toEqual(['one']))
    w.state.listed = ['a']
    await host.poll()
    await eventually(() => expect(w.bridges.get('b')!.socket!.readyState).toBe(3))
    expect(existsSync(join(dataDir, 'instance', bridgeId('b'), 'bridge.sqlite'))).toBe(true)
    expect(await transaction('t2', [message('!b:test', 'unheard')])).toBe(200)
    await pause(300)
    expect(w.state.leaves.filter(left => left.startsWith('!b:test'))).toEqual([])
    w.state.listed = ['a', 'b']
    await host.poll()
    await ready(w, 'b')
    await pause(1_600)
    expect(w.state.leaves.filter(left => left.startsWith('!b:test'))).toEqual([])
    // Its event map is there: a repeated event is no new message.
    expect(await transaction('t1', [message('!b:test', 'again', { event_id: '$stay' })])).toBe(200)
    await eventually(() => expect(w.texts('b')).toEqual(['one', 'again']))
    w.state.listed = ['a']
    await host.poll()
    await eventually(() => expect(w.state.leaves).toContain(`!b:test ${bot}`))
    expect(w.state.leaves.indexOf(`!b:test ${ghost}`)).toBeLessThan(w.state.leaves.indexOf(`!b:test ${bot}`))
    expect(existsSync(join(dataDir, 'instance', bridgeId('b'), 'bridge.sqlite'))).toBe(true)
    expect(w.state.leaves.filter(left => left.startsWith('!a:test'))).toEqual([])
  }, 15_000)
  it('runs again with its events and ghosts after the host was restarted', async () => {
    const { w, host, transaction, dataDir } = await pairedWorld()
    const event = message('!a:test', 'one')
    expect(await transaction('t1', [event])).toBe(200)
    await eventually(() => expect(w.texts('a')).toEqual(['one']))
    await eventually(() => expect(w.state.membership.get(`!a:test ${ghost}`)).toBe('join'))
    await host.stop()
    const registered = w.state.registers.length
    const joins = w.state.joins.length
    const again = await start(w, { dataDir })
    await ready(w, 'a', 'b')
    await eventually(async () => expect(await again.transaction('t1', [event])).toBe(200))
    w.harmony('a', 'two')
    await eventually(() => expect(w.said('!a:test')).toEqual(['two']))
    expect(w.texts('a')).toEqual(['one'])
    // The service's own user is made known again at each start, the ghost is not.
    expect(w.state.registers.slice(registered)).toEqual(['harmony_relay'])
    expect(w.state.joins.length).toBe(joins)
  })
})

describe('linking a room by its code', () => {
  async function linking(options: Parameters<typeof start>[1] = {}, membersOfA = [userId]) {
    const running = await pairedWorld(options, 'application_service', membersOfA)
    const { w } = running
    w.addBridge('c')
    w.state.listed.push('c')
    w.state.codes.set('ML-CCCC-CCCC-CCCC', { name: 'c', channel: channelOf('c') })
    await running.host.poll()
    return running
  }
  it('joins on an invitation, links, answers once and bridges; the command goes nowhere else', async () => {
    const { w, transaction, lines } = await linking({ timings: { linkMs: 60_000 } })
    expect(await transaction('t1', [invite('!new:test')])).toBe(200)
    await eventually(() => expect(w.state.joins).toContain(`!new:test ${bot}`))
    const command = message('!new:test', '!harmony link ML-cccc-cccc-cccc')
    expect(await transaction('t2', [message('!new:test', 'before'), command])).toBe(200)
    await eventually(() => expect(w.state.links).toEqual([{ code: 'ML-CCCC-CCCC-CCCC', room_id: '!new:test', sender: alice }]))
    await ready(w, 'c')
    await eventually(() => expect(w.said('!new:test')).toEqual(['This room is now linked with #channel-c on Server c.']))
    expect(await transaction('t2', [command])).toBe(200)
    expect(await transaction('t3', [message('!new:test', 'after'), message('!new:test', '!harmony link ML-XXXX-XXXX-XXXX', { sender: '@bob:test' })])).toBe(200)
    await eventually(() => expect(w.texts('c')).toEqual(['after']))
    await eventually(() => expect(w.said('!new:test')).toHaveLength(2))
    expect(w.said('!new:test')[1]).toContain('Only someone who may change')
    expect(w.state.links).toHaveLength(1)
    w.harmony('c', 'hello')
    w.harmony('c', '!harmony link ML-DDDD-DDDD-DDDD')
    w.harmony('c', 'bye')
    await eventually(() => expect(w.said('!new:test').slice(2)).toEqual(['hello', 'bye']))
    expect(lines.join('\n')).not.toMatch(/ML-/)
    expect(lines).toContain('[63636363] Room linked')
  })
  it('moves a room that another server had: the account stays, the other server\'s people leave', async () => {
    const { w, transaction } = await linking({}, [otherUser])
    w.harmony('a', 'from a', otherUser)
    await eventually(() => expect(w.said('!a:test')).toEqual(['from a']))
    expect(await transaction('t1', [message('!a:test', '!harmony link ML-CCCC-CCCC-CCCC')])).toBe(200)
    await ready(w, 'c')
    await eventually(() => expect(w.bridges.get('a')!.statuses.at(-1)!.pairs).toEqual([]))
    expect(await transaction('t2', [message('!a:test', 'to c')])).toBe(200)
    await eventually(() => expect(w.texts('c')).toEqual(['to c']))
    w.harmony('a', 'refused', otherUser)
    w.harmony('c', 'from c')
    await eventually(() => expect(w.said('!a:test')).toEqual(['from a', 'This room is now linked with #channel-c on Server c.', 'from c']))
    await eventually(() => expect(w.state.leaves).toContain(`!a:test ${ghostOf(otherUser)}`))
    await pause(500)
    expect(w.state.leaves).not.toContain(`!a:test ${bot}`)
    expect(w.state.leaves).not.toContain(`!a:test ${ghost}`)
    expect(w.texts('a')).toEqual([])
  })
  it('links to a bridge the list did not have yet', async () => {
    const { w, transaction } = await pairedWorld()
    w.addBridge('d')
    w.state.codes.set('ML-DDDD', { name: 'd', channel: channelOf('d') })
    w.state.listed.push('d')
    expect(await transaction('t1', [invite('!new:test')])).toBe(200)
    await eventually(() => expect(w.state.joins).toContain(`!new:test ${bot}`))
    expect(await transaction('t2', [message('!new:test', '!harmony link ML-DDDD')])).toBe(200)
    await ready(w, 'd')
    await pause(800)
    expect(w.state.leaves).toEqual([])
  })
  it('leaves a room where no code is posted in time, one whose pair is gone, and none else', async () => {
    const { w, transaction, host } = await pairedWorld()
    w.state.membership.set(`!own:test ${bot}`, 'join')
    expect(await transaction('t1', [invite('!new:test'), message('!own:test', 'the account was here before')])).toBe(200)
    await eventually(() => expect(w.state.joins).toContain(`!new:test ${bot}`))
    await pause(200)
    expect(w.state.leaves).toEqual([])
    await eventually(() => expect(w.state.leaves).toEqual([`!new:test ${bot}`]))
    expect(w.state.reasons).toEqual(['No code was posted in this room.'])
    await eventually(() => expect(w.state.membership.get(`!b:test ${ghost}`)).toBe('join'))
    w.bridges.get('b')!.pairs = []
    w.configChanged('b')
    await eventually(() => expect(w.bridges.get('b')!.statuses.at(-1)!.pairs).toEqual([]))
    await pause(200)
    // Until every bridge was asked, the room may have moved to another.
    expect(w.state.leaves.slice(1)).toEqual([`!b:test ${ghost}`])
    w.configChanged('b')
    w.configChanged('a')
    await eventually(() => expect(w.state.leaves.slice(1)).toEqual([`!b:test ${ghost}`, `!b:test ${bot}`]))
    await pause(800)
    expect(w.state.leaves).toHaveLength(3)
    expect(inner(host).store.rooms().map((room: { roomId: string }) => room.roomId)).toEqual(['!a:test'])
  })
  it('declines or leaves an encrypted room at once, with the reason', async () => {
    const { w, transaction } = await linking({ timings: { linkMs: 60_000 } })
    expect(await transaction('t1', [invite('!secret:test', [{ type: 'm.room.encryption', state_key: '', content: {} }])])).toBe(200)
    await eventually(() => expect(w.state.leaves).toEqual([`!secret:test ${bot}`]))
    expect(w.state.joins).not.toContain(`!secret:test ${bot}`)
    w.state.encrypted.add('!hidden:test')
    expect(await transaction('t2', [invite('!hidden:test')])).toBe(200)
    await eventually(() => expect(w.state.leaves).toEqual([`!secret:test ${bot}`, `!hidden:test ${bot}`]))
    expect(w.said('!hidden:test')).toEqual([expect.stringContaining('end-to-end encrypted')])
    expect(await transaction('t3', [invite('!later:test')])).toBe(200)
    await eventually(() => expect(w.state.joins).toContain(`!later:test ${bot}`))
    await pause(100)
    w.state.encrypted.add('!later:test')
    expect(await transaction('t4', [{ type: 'm.room.encryption', event_id: '$enc', room_id: '!later:test', sender: alice, state_key: '', content: {} }])).toBe(200)
    await eventually(() => expect(w.state.leaves).toContain(`!later:test ${bot}`))
    expect(w.state.reasons.every(reason => reason.includes('end-to-end encrypted'))).toBe(true)
    // In a room that is linked already: said, and the account stays.
    w.state.encrypted.add('!a:test')
    expect(await transaction('t5', [message('!a:test', '!harmony link ML-CCCC-CCCC-CCCC')])).toBe(200)
    await eventually(() => expect(w.said('!a:test')).toEqual([expect.stringContaining('end-to-end encrypted')]))
    expect(w.state.leaves).not.toContain(`!a:test ${bot}`)
    expect(w.state.links).toEqual([])
  })
  it('waits in no more than fifty rooms', async () => {
    const { w, transaction } = await linking({ timings: { linkMs: 60_000 } })
    expect(await transaction('t1', Array.from({ length: MAX_WAITING_ROOMS + 2 }, (_, index) => invite(`!many${index}:test`)))).toBe(200)
    await eventually(() => expect(w.state.leaves).toHaveLength(2))
    expect(w.state.joins.filter(join => join.startsWith('!many'))).toHaveLength(MAX_WAITING_ROOMS)
    expect(w.state.reasons).toEqual(Array(2).fill('The bridge waits in too many rooms. Invite it again later.'))
    // A paired room's invitation is taken all the same.
    expect(await transaction('t2', [invite('!a:test')])).toBe(200)
    await eventually(() => expect(w.state.joins.filter(join => join === `!a:test ${bot}`)).toHaveLength(2))
  })
  it('gives up an invitation that is withdrawn, and goes on', async () => {
    const { w, transaction, host } = await linking({ timings: { linkMs: 60_000 } })
    expect(await transaction('t1', [invite('!gone:test'), invite('!new:test')])).toBe(200)
    await eventually(() => expect(w.state.joins).toContain(`!new:test ${bot}`))
    await eventually(() => expect(inner(host).store.invites()).toEqual([]))
  })
  it('lets a homeserver that never answers hold up no other invitation', async () => {
    const { w, transaction } = await linking({ timings: { linkMs: 60_000 } })
    expect(await transaction('t1', Array.from({ length: 4 }, (_, index) => invite(`!hangs${index}:test`)))).toBe(200)
    expect(await transaction('t2', [invite('!new:test')])).toBe(200)
    await eventually(() => expect(w.state.joins).toContain(`!new:test ${bot}`))
    expect(await transaction('t3', [message('!new:test', '!harmony link ML-CCCC-CCCC-CCCC')])).toBe(200)
    await ready(w, 'c')
  })
  it('takes no room a code did not link', async () => {
    const w = await world()
    w.addBridge('a', [pair('a', '!a:test'), { ...pair('z', '!z:test'), room_id: null, room_alias: '#public:test' }])
    w.state.listed = ['a']
    await start(w)
    await ready(w, 'a')
    await pause(200)
    expect(w.state.joins.filter(join => join.endsWith(bot))).toEqual([`!a:test ${bot}`])
    expect(w.state.aliases).toEqual([])
  })
  it('forgets a waiting room it was removed from', async () => {
    const { w, transaction, host } = await linking({ timings: { linkMs: 60_000 } })
    expect(await transaction('t1', [invite('!new:test')])).toBe(200)
    await eventually(() => expect(inner(host).store.rooms().map((room: { roomId: string }) => room.roomId)).toContain('!new:test'))
    expect(await transaction('t2', [{ ...invite('!new:test'), content: { membership: 'leave' } }])).toBe(200)
    expect(inner(host).store.rooms().map((room: { roomId: string }) => room.roomId)).not.toContain('!new:test')
  })
})

describe('the instance\'s connection with an account', () => {
  it('reads one sync for every bridge, and links from a room\'s first events', async () => {
    const { w, host } = await pairedWorld({ timings: { linkMs: 60_000 } }, 'account')
    await eventually(() => expect(w.state.hostStatuses.at(-1)!.instance).toEqual({ ready: true, user_id: account, server_name: 'test', problems: [] }))
    await eventually(() => expect(w.state.filters.at(-1).room.rooms).toEqual(['!a:test', '!b:test']))
    await eventually(() => expect(inner(host).store.syncState(account)?.rooms).toEqual(['!a:test', '!b:test']))
    w.sync({ room: '!a:test', events: [message('!a:test', 'to a')] })
    w.sync({ room: '!b:test', events: [message('!b:test', 'to b')] })
    await eventually(() => expect([w.texts('a'), w.texts('b')]).toEqual([['to a'], ['to b']]))
    w.harmony('a', 'from a')
    await eventually(() => expect(w.state.posts).toEqual([expect.objectContaining({ room: '!a:test', sender: account, body: '[Alice · Harmony] from a' })]))
    expect(w.state.registers).toEqual([])

    w.addBridge('c')
    w.state.listed.push('c')
    w.state.codes.set('ML-CCCC', { name: 'c', channel: channelOf('c') })
    await host.poll()
    // Posted at once: part of what the room's first answer holds.
    w.state.onJoin.set('!new:test', () => w.state.queue.push({ room: '!new:test', events: [message('!new:test', 'long ago', { origin_server_ts: 1 }), message('!new:test', '!harmony link ML-CCCC', { origin_server_ts: 1 }), message('!new:test', '!harmony link ML-CCCC'), message('!new:test', 'not yet paired')] }))
    w.sync({ invite: '!new:test' })
    await eventually(() => expect(w.state.links).toEqual([{ code: 'ML-CCCC', room_id: '!new:test', sender: alice }]))
    await ready(w, 'c')
    await eventually(() => expect(inner(host).store.syncState(account)?.rooms).toContain('!new:test'))
    w.sync({ room: '!new:test', events: [message('!new:test', 'now')] })
    await eventually(() => expect(w.texts('c')).toEqual(['now']))
  })
  it('keeps the sync token where it was until every bridge stored its part', async () => {
    const { w, host } = await pairedWorld({}, 'account')
    await eventually(() => expect(inner(host).store.syncState(account)?.rooms).toEqual(['!a:test', '!b:test']))
    const accept = Store.prototype.acceptEvents
    let failing = 1
    vi.spyOn(Store.prototype, 'acceptEvents').mockImplementation(function (this: Store, jobs, fences) {
      if (jobs.some(job => job.channelId === channelOf('b')) && failing-- > 0) throw new Error('disk')
      return accept.call(this, jobs, fences)
    })
    const before = inner(host).store.syncState(account)!.nextBatch
    w.sync({ room: '!a:test', events: [message('!a:test', 'one')] }, { room: '!b:test', events: [message('!b:test', 'two')] })
    await eventually(() => expect(failing).toBeLessThan(1))
    expect(inner(host).store.syncState(account)!.nextBatch).toBe(before)
    await eventually(() => expect([w.texts('a'), w.texts('b')]).toEqual([['one'], ['two']]), 12_000)
    expect(w.bridges.get('a')!.sockets).toBe(1)
    expect(w.bridges.get('b')!.sockets).toBe(2)
  }, 20_000)
  it('says when its token is refused', async () => {
    const { w } = await pairedWorld({}, 'account')
    w.state.refuseMatrix = true
    await eventually(() => expect(w.state.hostStatuses.at(-1)!.instance).toMatchObject({ ready: false, problems: [{ code: 'matrix_token_invalid', detail: expect.stringContaining('admin panel') }] }))
    await eventually(() => expect(w.bridges.get('a')!.statuses.at(-1)!.problems[0]).toMatchObject({ code: 'matrix_token_invalid' }))
  })
})

describe('the host', () => {
  it('reports as soon as it read the list, also without a connection of the instance', async () => {
    const w = await world()
    w.state.instance = false
    await start(w, { timings: { hostStatusMs: 600_000 } })
    await eventually(() => expect(w.state.hostStatuses).toEqual([{ version: '1.0.0-test', instance: null, hosted: 0 }]))
  })
  it('reports at once what changed, not at its next interval', async () => {
    const w = await world()
    w.state.refuseMatrix = true
    const { host } = await start(w, { timings: { hostStatusMs: 600_000 } })
    await eventually(() => expect(w.state.hostStatuses.at(-1)?.instance?.problems).toEqual([{ code: 'matrix_registration_missing' }]))
    w.state.refuseMatrix = false
    await eventually(() => expect(w.state.hostStatuses.at(-1)?.instance).toEqual({ ready: true, user_id: bot, server_name: 'test', problems: [] }))
    const sent = w.state.hostStatuses.length
    await pause(300)
    expect(w.state.hostStatuses.length).toBe(sent)
    w.state.instance = false
    await host.poll()
    await eventually(() => expect(w.state.hostStatuses.at(-1)!.instance).toBeNull())
  })

  /** A thread that claims the user its access token names. */
  function worker(): URL {
    const path = join(directory(), 'worker.mjs')
    writeFileSync(path, `import { parentPort, workerData } from 'node:worker_threads'
      import { mkdirSync, writeFileSync } from 'node:fs'
      mkdirSync(workerData.dataDir, { recursive: true })
      writeFileSync(workerData.dataDir + '/started-' + workerData.accessToken, JSON.stringify(workerData))
      let granted = false
      const claim = () => parentPort.postMessage({ type: 'claim', id: 1, homeserverUrl: workerData.homeserverUrl, userId: '@' + workerData.accessToken + ':test' })
      claim()
      setInterval(() => { if (!granted) claim(); parentPort.postMessage({ type: 'health', health: { ready: granted, pending: 0, failed: 0 } }) }, 20)
      parentPort.on('message', message => { if (message.type === 'stop') process.exit(0); granted = message.granted })
      if (workerData.accessToken === 'syt_account_loops') setTimeout(() => { for (;;); }, 30)`)
    return pathToFileURL(path)
  }
  const entry = (name: string, access: string, extra: Record<string, unknown> = {}) => ({ bridge_id: bridgeId(name), harmony_token: tokenOf(name), homeserver_url: 'https://matrix.test', access_token: access, ...extra })
  const started = (dataDir: string, name: string) => { try { return readdirSync(join(dataDir, 'hosted', bridgeId(name))) } catch { return [] } }

  it('starts, changes and stops hosted bridges as Harmony lists them, and keeps their data', async () => {
    const w = await world()
    w.state.instance = false
    w.state.hosted = [entry('x', 'syt_account_one'), entry('y', 'syt_account_two')]
    const { host, health, dataDir, lines } = await start(w, { workerUrl: worker() })
    await eventually(async () => expect(await health()).toEqual({ status: 200, body: { ready: true, mode: 'host', hosted: 2, hosted_ready: 2, instance: null } }))
    await eventually(() => expect(w.state.hostStatuses.at(-1)).toEqual({ version: '1.0.0-test', instance: null, hosted: 2 }))
    w.state.hosted = [entry('x', 'syt_account_renewed'), entry('z', 'syt_account_three')]
    await host.poll()
    await eventually(() => expect([started(dataDir, 'x'), started(dataDir, 'z')]).toEqual([['started-syt_account_one', 'started-syt_account_renewed'], ['started-syt_account_three']]))
    await eventually(() => expect(host.status()).toMatchObject({ hosted: 2, hosted_ready: 2 }))
    expect(started(dataDir, 'y')).toEqual(['started-syt_account_two'])
    w.state.listStatus = 503
    await host.poll()
    expect(host.status()).toMatchObject({ ready: true, hosted: 2 })
    w.state.listStatus = 200
    w.state.hosted = []
    await host.poll()
    await eventually(() => expect(host.status()).toMatchObject({ hosted: 0 }))
    expect(started(dataDir, 'x')).toHaveLength(2)
    await host.stop()
    expect(lines.join('\n')).not.toContain('syt_')
    expect(lines.join('\n')).not.toContain('secret')
  })
  it('lets one that loops stop neither another nor itself for long', async () => {
    const w = await world()
    w.addBridge('a', [pair('a', '!a:test')])
    w.state.listed = ['a']
    w.state.hosted = [entry('x', 'syt_account_one'), entry('y', 'syt_account_loops')]
    const { host, transaction, lines, health } = await start(w, { workerUrl: worker(), hosted: { hangMs: 300, restart: { baseMs: 50, maxMs: 100, stableMs: 60_000 } } })
    await ready(w, 'a')
    await eventually(() => expect(lines.filter(line => line.includes('it no longer responded')).length).toBeGreaterThanOrEqual(2))
    expect(lines.every(line => !line.startsWith(`[${bridgeId('x').slice(0, 8)}] Bridge stopped`))).toBe(true)
    expect(await transaction('t1', [message('!a:test', 'one')])).toBe(200)
    await eventually(() => expect(w.texts('a')).toEqual(['one']))
    expect(host.status()).toMatchObject({ ready: true, hosted: 2 })
    expect((await health()).status).toBe(200)
  })
  it('gives an account to the first bridge, and frees it when that one goes', async () => {
    const w = await world()
    w.state.instance = false
    w.state.hosted = [entry('x', 'syt_account_same')]
    const { host } = await start(w, { workerUrl: worker() })
    await eventually(() => expect(host.status()).toMatchObject({ hosted_ready: 1 }))
    w.state.hosted = [entry('x', 'syt_account_same'), entry('y', 'syt_account_same'), entry('z', 'syt_account_same', { homeserver_url: 'https://elsewhere.test' })]
    await host.poll()
    // Another homeserver's user of that name is someone else.
    await eventually(() => expect(host.status()).toMatchObject({ hosted: 3, hosted_ready: 2 }))
    await pause(200)
    expect(host.status()).toMatchObject({ hosted_ready: 2 })
    w.state.hosted = w.state.hosted.slice(1)
    await host.poll()
    await eventually(() => expect(host.status()).toMatchObject({ hosted: 2, hosted_ready: 2 }))
  })
  it('keeps the instance\'s account for the instance', async () => {
    const w = await world()
    w.state.connection = 'account'
    w.state.instance = false
    w.state.whoami = '@syt_account_same:test'
    w.state.hosted = [entry('x', 'syt_account_same', { homeserver_url: `https://127.0.0.1:${w.port}` })]
    const { host } = await start(w, { workerUrl: worker(), hosted: { restart: { baseMs: 50, maxMs: 100, stableMs: 60_000 } } })
    await eventually(() => expect(host.status()).toMatchObject({ hosted_ready: 1 }))
    const claim = (host as unknown as { claim(owner: string, homeserver: string, user: string): boolean }).claim.bind(host)
    expect(claim('instance', `https://127.0.0.1:${w.port}/`, '@syt_account_same:test')).toBe(true)
    await eventually(() => expect(host.status()).toMatchObject({ hosted: 1, hosted_ready: 0 }))
    await pause(300)
    expect(host.status()).toMatchObject({ hosted_ready: 0 })
    expect(claim('instance', 'not an address', '@syt_account_same:test')).toBe(false)
  })
  it.each([[401, /refuses BRIDGE_HOST_SECRET/], [404, /hosts no Matrix bridges/], [503, /Cannot read the bridge list/]])('says once why it cannot read its list (%i), and is healthy only while it can', async (status, reason) => {
    const w = await world()
    w.state.listStatus = status
    const { host, health, lines } = await start(w, { timings: { healthyMs: 300 } })
    expect((await health()).status).toBe(503)
    await pause(200)
    expect(lines.filter(line => reason.test(line))).toHaveLength(1)
    expect(w.state.hostStatuses).toEqual([])
    w.state.listStatus = 200
    w.state.listed = []
    await eventually(async () => expect((await health()).status).toBe(200))
    w.state.listStatus = status
    await host.poll()
    expect((await health()).status).toBe(200)
    await eventually(async () => expect((await health()).status).toBe(503))
  })
  it('refuses a wrong secret\'s answer and waits for a Harmony that is not there yet', async () => {
    const w = await world()
    const { lines } = await start(w, { secret: 'x'.repeat(40) })
    expect(lines).toEqual([expect.stringMatching(/refuses BRIDGE_HOST_SECRET/)])
    const gone = await world()
    const server = servers.at(-1)!
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    const waiting = await start(gone)
    expect(waiting.lines).toEqual([expect.stringMatching(/Cannot read the bridge list/)])
    server.listen(gone.port, '127.0.0.1')
    await eventually(async () => expect((await waiting.health()).status).toBe(200))
  })
  it('cannot use a data directory it may not write', async () => {
    const w = await world()
    const dataDir = directory()
    writeFileSync(join(dataDir, 'file'), '')
    await expect(start(w, { dataDir: join(dataDir, 'file') })).rejects.toThrow('DATA_DIR')
    // The instance's own folder alone: reported, and tried again.
    const other = directory()
    writeFileSync(join(other, 'instance'), '')
    const { host, lines } = await start(w, { dataDir: other })
    await eventually(() => expect(w.state.hostStatuses.at(-1)!.instance).toMatchObject({ ready: false, problems: [{ code: 'worker_stopped' }] }))
    expect(lines.filter(line => line.includes('could not start'))).toHaveLength(1)
    rmSync(join(other, 'instance'))
    await host.poll()
    await eventually(() => expect(w.state.hostStatuses.at(-1)!.instance).toMatchObject({ ready: true }))
  })
  it('sends secrets, codes and people to nobody\'s log', async () => {
    const { w, host, transaction, lines } = await pairedWorld()
    w.state.codes.set('ML-CCCC', { name: 'a', channel: channelOf('a') })
    expect(await transaction('t1', [message('!b:test', '!harmony link ML-CCCC'), message('!a:test', 'private words')])).toBe(200)
    await eventually(() => expect(w.state.links).toHaveLength(1))
    host.crashed(bridgeId('a'), new Error(`${accessToken} ${alice} private words`))
    await pause(300)
    for (const hidden of ['ML-', 'private words', alice, '@', 'syt_', 'harmony_bot', asToken, hsToken, secret]) expect(lines.join('\n')).not.toContain(hidden)
  })
})
