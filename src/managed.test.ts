import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StatusReport } from './BridgeApi.js'
import type { MatrixPlan } from './env.js'
import { FatalConfigError, ManagedBridge } from './managed.js'
import { Relay } from './Relay.js'
import { Store } from './Store.js'
import { TOKEN_HINT } from './SyncLoop.js'

const channelId = '22222222-2222-4222-8222-222222222222'
const otherChannel = '33333333-3333-4333-8333-333333333333'
const userId = '11111111-1111-4111-8111-111111111111'
const ghost = '@harmony_relay_h_11111111111141118111111111111111:test'
const harmonyToken = `harmony_bot_${'a'.repeat(64)}`
const accessToken = 'syt_account_token_0123456789'

const servers: Server[] = []
const bridges: ManagedBridge[] = []
const children: ChildProcess[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(bridges.splice(0).map(bridge => bridge.stop()))
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit').catch(() => {}) }
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
  const path = mkdtempSync(join(tmpdir(), 'matrix-managed-test-'))
  directories.push(path)
  return path
}
const pair = (overrides: Record<string, unknown> = {}) => ({ channel_id: channelId, channel_name: 'general', room_id: null, room_alias: '#general:test', direction: 'both',
  sender_mode: 'ghost', encrypted: false, ...overrides })

/** bot-gateway and a homeserver in one, by the shapes of DESIGN.md (contract and addenda). */
async function world() {
  const state = {
    registers: [] as string[], updatedAt: '', ghostsExist: false, whoamiRefused: false, redeem: 200, configStatus: 200, pairs: [] as Array<Record<string, unknown>>, privacyVersion: '1', optedOut: [] as string[],
    capabilities: ['matrix_bridge_v2', 'matrix_bridge_check'], optedOutMembers: [] as string[], requests: [] as string[], refuseAs: false, refuseAccount: false, refuseAuthor: false,
    redeems: [] as unknown[], statuses: [] as StatusReport[], binds: [] as unknown[], joins: [] as string[], leaves: [] as string[], harmonyPosts: [] as any[], matrixPosts: [] as any[],
    memberFrames: [] as any[], privacyCalls: [] as string[], identified: 0, membership: new Map<string, string>(), encrypted: new Set<string>(), syncs: [] as URLSearchParams[],
    wellKnown: null as unknown, pendingSync: null as null | { res: ServerResponse; since: number }, queue: [] as Array<{ room: string; events: unknown[]; limited?: boolean }>, hsToken: '', asToken: '',
  }
  let gateway: WebSocket | undefined
  // A token is a position in the queue: an answer that never arrived is given again.
  const answerSync = () => {
    const pending = state.pendingSync
    if (!pending) return
    state.pendingSync = null
    const join: Record<string, any> = {}
    for (const entry of state.queue.slice(pending.since)) {
      join[entry.room] ??= { timeline: { events: [], limited: entry.limited ?? false, prev_batch: 'p' }, state: { events: [] } }
      join[entry.room].timeline.events.push(...entry.events)
    }
    pending.res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ next_batch: `s${state.queue.length}`, rooms: { join } }))
  }
  const remote = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost')
    const path = decodeURIComponent(url.pathname)
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    const send = (result: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(result)) }
    if (path === '/bot-gateway/health') return send({ status: 'ok' })
    if (path === '/.well-known/matrix/client') return state.wellKnown ? send(state.wellKnown) : send({}, 404)
    if (state.wellKnown && path.startsWith('/_matrix/')) return send({}, 404)
    if (path === '/bot-gateway/bridge/v2/matrix/redeem') {
      state.redeems.push(input)
      const base = `http://127.0.0.1:${port}`
      return state.redeem === 200 ? send({ bridge_id: 'b1', server_id: 's1', harmony_token: harmonyToken, base_url: base, api_url: `${base}/bot-gateway`, gateway_url: `ws://127.0.0.1:${port}/bot-gateway/gateway` })
        : send({ code: 'invalid_code' }, state.redeem)
    }
    if (path.startsWith('/bot-gateway/')) {
      if (req.headers.authorization !== `Bot ${harmonyToken}`) return send({}, 401)
      const route = path.slice('/bot-gateway/'.length)
      state.requests.push(`${req.method} ${route}`)
      const paired = state.pairs.find(candidate => route.includes(candidate.channel_id as string))
      const member = { id: userId, username: 'Alice', display_name: 'Alice', avatar_url: null, domain: 'test' }
      if (route.endsWith('/bridge-check') && state.capabilities.includes('matrix_bridge_check')) {
        const asked = url.searchParams.get('user_id')
        const allowed = asked === null ? null : !state.optedOutMembers.includes(asked)
        return send(!paired ? { platform: null, room_id: null, sender_mode: null, messages_encrypted: null, relay_allowed: null, member: null }
          : { platform: 'matrix', room_id: paired.room_id, sender_mode: paired.sender_mode, messages_encrypted: false, relay_allowed: allowed, member: allowed && asked === userId ? member : null })
      }
      if (route === 'bridge/v2/matrix/config') return state.configStatus === 200 ? send({ bridge_id: 'b1', server_id: 's1', mode: 'self', updated_at: `${state.updatedAt} ${state.pairs.length}`,
        base_url: null, privacy_version: state.privacyVersion, pairs: state.pairs }) : send({}, state.configStatus)
      if (route === 'bridge/v2/matrix/status') { state.statuses.push(input); return send({ ok: true }) }
      if (route.startsWith('bridge/v2/matrix/privacy/')) {
        state.privacyCalls.push(`${req.method} ${route.slice('bridge/v2/matrix/privacy/'.length)}`)
        if (route.endsWith('/optouts')) return send({ version: state.privacyVersion, remote_user_ids: state.optedOut })
        return send({ opted_out: req.method === 'PUT', since: null, source: 'user' })
      }
      if (route.endsWith('/bridge-platform')) return send({ platform: paired ? 'matrix' : null })
      if (route.endsWith('/bridge-room')) {
        if (req.method === 'PUT') {
          state.binds.push(input)
          const bound = state.pairs.find(candidate => route.includes(candidate.channel_id as string))
          if (bound?.room_alias && input.room_alias !== bound.room_alias) return send({ code: 'room_changed' }, 409)
          if (bound) bound.room_id = input.room_id
        }
        return paired ? send({ room_id: paired.room_id, sender_mode: paired.sender_mode }) : send({}, 403)
      }
      if (route.endsWith('/bridge-members')) return send(state.optedOutMembers.includes(userId) ? [] : [member])
      if (route.includes('/bridge-consent/')) return send({ relay_allowed: !state.optedOutMembers.some(id => route.endsWith(id)) })
      if (route.endsWith('/encryption')) return send({ messages_encrypted: false })
      if (route.endsWith('/messages')) {
        if (state.refuseAuthor) return send({ error: 'SECRET', code: 'BRIDGE_AUTHOR_OPTED_OUT' }, 403)
        state.harmonyPosts.push(input)
        return send({ id: `h${state.harmonyPosts.length}` })
      }
      return send({}, 404)
    }
    const bearer = req.headers.authorization
    if (bearer === `Bearer ${accessToken}` ? state.refuseAccount : state.refuseAs || bearer !== `Bearer ${state.asToken}`) return send({ errcode: 'M_UNKNOWN_TOKEN', error: 'SECRET' }, 401)
    const self = url.searchParams.get('user_id') ?? '@community:test'
    const room = /\/rooms\/([^/]+)\//.exec(path)?.[1] ?? ''
    if (path.endsWith('/register')) state.registers.push(input.username)
    if (path.endsWith('/register')) return state.ghostsExist && input.username.includes('_h_') ? send({ errcode: 'M_USER_IN_USE' }, 400) : send({ user_id: `@${input.username}:test` })
    if (path.endsWith('/account/whoami')) return state.whoamiRefused && self.includes('_h_') ? send({ errcode: 'M_FORBIDDEN' }, 403) : send({ user_id: self })
    if (path.includes('/directory/room/')) return path.endsWith('#general:test') ? send({ room_id: '!general:test', servers: ['test'] }) : send({ errcode: 'M_NOT_FOUND' }, 404)
    if (path.includes('/v3/join/')) {
      const target = path.split('/v3/join/')[1]
      if (target === '!private:test') return send({ errcode: 'M_FORBIDDEN' }, 403)
      state.joins.push(`${target} ${self}`)
      state.membership.set(`${target} ${self}`, 'join')
      return send({ room_id: target })
    }
    if (path.endsWith('/leave')) { state.leaves.push(`${room} ${self}`); state.membership.set(`${room} ${self}`, 'leave'); return send({}) }
    if (path.endsWith('/invite')) return send({})
    if (path.endsWith('/joined_members')) return send({ joined: { '@alice:test': { display_name: 'Room Alice' } } })
    if (path.endsWith('/joined_rooms')) return send({ joined_rooms: [...state.membership].filter(([key, value]) => key.endsWith(` ${self}`) && value === 'join').map(([key]) => key.split(' ')[0]) })
    if (path.endsWith('/account_data/m.direct')) return send({ errcode: 'M_NOT_FOUND' }, 404)
    if (path.includes('/state/m.room.member/')) {
      const member = path.split('/state/m.room.member/')[1]
      if (req.method === 'PUT') { state.membership.set(`${room} ${member}`, 'join'); return send({ event_id: '$member' }) }
      if (member === '@alice:test') return send({ membership: 'join', displayname: 'Room Alice' })
      const membership = state.membership.get(`${room} ${member}`)
      return membership ? send({ membership }) : send({ errcode: 'M_NOT_FOUND' }, 404)
    }
    if (path.endsWith('/state/m.room.encryption/')) return state.encrypted.has(room) ? send({ algorithm: 'm.megolm.v1.aes-sha2' }) : send({ errcode: 'M_NOT_FOUND' }, 404)
    if (path.endsWith('/state/m.room.name/')) return send({ name: `Name of ${room}` })
    if (path.includes('/state/')) return send({ errcode: 'M_NOT_FOUND' }, 404)
    if (path.includes('/send/')) { state.matrixPosts.push({ ...input, sender: self, room }); return send({ event_id: `$m${state.matrixPosts.length}` }) }
    if (path.endsWith('/filter')) return send({ filter_id: 'f' })
    if (path.endsWith('/sync')) {
      state.syncs.push(url.searchParams)
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
    gateway = socket
    socket.on('message', bytes => {
      const frame = JSON.parse(bytes.toString())
      if (frame.op === 2) { state.identified++; socket.send(JSON.stringify({ op: 0, t: 'READY', d: { heartbeat_interval: 60_000, capabilities: state.capabilities } })) }
      if (frame.op === 6) state.memberFrames.push(frame.d)
    })
  })
  const port = await listen(remote)
  return {
    state, port,
    url: `http://127.0.0.1:${port}`,
    configChanged: () => gateway!.send(JSON.stringify({ op: 0, t: 'BRIDGE_CONFIG_UPDATE', d: { bridge_id: 'b1' } })),
    harmonyMessage: (id: string, text: string) => gateway!.send(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', d: { id, channel_id: channelId, author: { id: userId, username: 'Alice' },
      content: text, content_raw: [{ type: 'text', text }], metadata: {}, is_system: false } })),
    matrixEvents: (room: string, events: unknown[], extra: { limited?: boolean } = {}) => { state.queue.push({ room, events, ...extra }); answerSync() },
    dropGateway: () => gateway!.close(4004, 'Invalid or expired token'),
  }
}
async function freePort(): Promise<number> {
  const server = createServer()
  const port = await listen(server)
  await new Promise<void>(resolve => server.close(() => resolve()))
  servers.splice(servers.indexOf(server), 1)
  return port
}
const matrixEvent = (id: string, body: string, extra: Record<string, unknown> = {}) => ({ type: 'm.room.message', event_id: id, sender: '@alice:test', origin_server_ts: Date.now(), content: { msgtype: 'm.text', body }, ...extra })

async function start(w: Awaited<ReturnType<typeof world>>, kind: MatrixPlan['kind'], dataDir = directory(), setupCode: string | null = 'MX-AAAA-BBBB-CCCC') {
  const port = await freePort()
  const lines: string[] = []
  const matrix: MatrixPlan = kind === 'account' ? { kind, homeserverUrl: w.url, accessToken }
    : { kind, homeserverUrl: w.url, serverName: 'test', senderLocalpart: 'harmony_relay', applicationServiceUrl: `http://127.0.0.1:${port}`, tokens: null }
  const bridge = new ManagedBridge({ kind: 'managed', harmonyUrl: w.url, setupCode, matrix, dataDir, listen: { host: '127.0.0.1', port }, ignoredConfig: null },
    { version: '0.2.0-test', log: line => lines.push(line), warn: line => lines.push(line),
      timings: { configMs: 60_000, configSoonMs: 5, statusMs: 60_000, statusSoonMs: 5, roomsMs: 50, matrixMs: 200, backoffMs: 50, memberFrameMs: 20 } })
  bridges.push(bridge)
  if (kind === 'application_service') {
    // The homeserver learns the tokens from the registration, as an operator would copy it.
    const poll = setInterval(() => {
      try {
        const file = JSON.parse(readFileSync(join(dataDir, 'registration.json'), 'utf8'))
        w.state.asToken = file.as_token
        w.state.hsToken = file.hs_token
        clearInterval(poll)
      } catch { /* Not written yet. */ }
    }, 2)
  }
  await bridge.start()
  const health = async () => { const response = await fetch(`http://127.0.0.1:${port}/health`); return { status: response.status, body: await response.json() as Record<string, unknown> } }
  const transaction = async (id: string, events: unknown[]) => (await fetch(`http://127.0.0.1:${port}/_matrix/app/v1/transactions/${id}`,
    { method: 'PUT', headers: { Authorization: `Bearer ${w.state.hsToken}` }, body: JSON.stringify({ events }) })).status
  const report = () => w.state.statuses.at(-1)
  return { bridge, lines, dataDir, port, health, transaction, report }
}
const eventually = (check: () => void | Promise<void>) => vi.waitFor(check, { timeout: 8_000, interval: 20 })

describe('a managed application service', () => {
  it('runs with no pair, then joins, relays and leaves as Harmony says', async () => {
    const w = await world()
    const { bridge, health, transaction, report, dataDir, lines } = await start(w, 'application_service')
    expect(w.state.redeems).toEqual([{ code: 'MX-AAAA-BBBB-CCCC' }])
    for (const name of ['credentials.json', 'appservice.json', 'registration.json', 'bridge.sqlite']) expect(statSync(join(dataDir, name)).mode & 0o777, name).toBe(0o600)
    await eventually(() => expect(report()).toMatchObject({ version: '0.2.0-test', connection: 'application_service', ready: true, user_id: '@harmony_relay:test',
      homeserver: w.url, server_name: 'test', pending: 0, failed: 0, pairs: [], problems: [] }))
    expect(await health()).toMatchObject({ status: 200, body: { ready: true, problems: [] } })

    w.state.pairs = [pair(), pair({ channel_id: otherChannel, room_id: '!private:test', room_alias: null })]
    w.configChanged()
    await eventually(() => expect(report()!.pairs).toEqual([{ channel_id: channelId, state: 'ready', error: null }, { channel_id: otherChannel, state: 'error', error: 'not_invited' }]))
    expect(report()).toMatchObject({ ready: true, problems: [{ code: 'room_not_joined', detail: '!private:test' }] })
    expect(w.state.joins.filter(join => join.endsWith('@harmony_relay:test'))).toEqual(['!general:test @harmony_relay:test'])
    expect(w.state.binds).toContainEqual({ room_id: '!general:test', initial_sender_mode: 'ghost', room_alias: '#general:test' })
    await eventually(() => expect(report()!.rooms).toEqual([{ room_id: '!general:test', name: 'Name of !general:test', alias: null, encrypted: false, can_send: true, members: 1 }]))
    await eventually(() => expect(w.state.memberFrames.at(-1).channels).toContainEqual({ harmonyChannelId: channelId,
      members: [{ id: '@alice:test', username: 'alice', displayName: 'Room Alice', avatarUrl: null, source: 'matrix' }] }))

    expect(await transaction('t1', [matrixEvent('$one', 'hello Harmony', { room_id: '!general:test' })])).toBe(200)
    await eventually(() => expect(w.state.harmonyPosts).toHaveLength(1))
    expect(w.state.harmonyPosts[0]).toMatchObject({ content: [{ type: 'text', text: 'hello Harmony' }], metadata: { bridge_author: { platform: 'matrix', id: '@alice:test', display_name: 'Room Alice' } } })
    w.harmonyMessage('h-native', 'hello Matrix')
    await eventually(() => expect(w.state.matrixPosts).toHaveLength(1))
    expect(w.state.matrixPosts[0]).toMatchObject({ sender: ghost, room: '!general:test', body: 'hello Matrix' })

    w.state.pairs = []
    w.configChanged()
    await eventually(() => expect(w.state.leaves).toContain(`!general:test ${ghost}`))
    await eventually(() => expect(report()!.pairs).toEqual([]))
    expect(w.state.leaves.filter(left => left.includes('@harmony_relay:test'))).toEqual([])
    await eventually(() => expect(w.state.memberFrames.at(-1).channels).toEqual([]))
    expect(await transaction('t2', [matrixEvent('$two', 'after', { room_id: '!general:test' })])).toBe(200)
    w.harmonyMessage('h-after', 'after')
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(w.state.harmonyPosts).toHaveLength(1)
    expect(w.state.matrixPosts).toHaveLength(1)
    expect(bridge.status()).toMatchObject({ ready: true })
    expect(lines.join('\n')).not.toMatch(/hello|SECRET|harmony_bot_/)
  }, 30_000)

  it('keeps running while the homeserver does not know it, says so, and goes on once it does', async () => {
    const w = await world()
    w.state.refuseAs = true
    w.state.pairs = [pair()]
    const { report, health, lines, dataDir } = await start(w, 'application_service')
    await eventually(() => expect(report()).toMatchObject({ connection: 'application_service', ready: false, problems: [{ code: 'matrix_registration_missing' }], rooms: [],
      pairs: [{ channel_id: channelId, state: 'joining', error: null }] }))
    expect(await health()).toMatchObject({ status: 503, body: { ready: false, problems: ['matrix_registration_missing'] } })
    expect(lines.join('\n')).toContain(join(dataDir, 'registration.json'))
    expect(w.state.joins).toEqual([])
    w.state.refuseAs = false
    await eventually(() => expect(report()).toMatchObject({ ready: true, problems: [], pairs: [{ state: 'ready' }] }))
  }, 20_000)

  it('refuses transactions until it knows its pairs, and loses none sent meanwhile', async () => {
    const w = await world()
    w.state.configStatus = 503
    w.state.pairs = [pair({ room_id: '!general:test' })]
    const { transaction, health, report, bridge } = await start(w, 'application_service')
    await eventually(() => expect(w.state.hsToken).not.toBe(''))
    const events = [matrixEvent('$early', 'early', { room_id: '!general:test' })]
    expect(await transaction('t1', events)).toBe(503)
    expect(await health()).toMatchObject({ status: 503, body: { problems: expect.arrayContaining(['harmony_unreachable']) } })
    w.state.configStatus = 200
    await bridge.refreshConfig()
    expect(await transaction('t1', events)).toBe(200)
    await eventually(() => expect(w.state.harmonyPosts).toHaveLength(1))
    expect(report()).toBeDefined()
  }, 20_000)

  it('starts again from its saved credentials, without a code, and keeps its queue, ghosts and tokens', async () => {
    const w = await world()
    w.state.pairs = [pair()]
    const first = await start(w, 'application_service')
    await eventually(() => expect(first.report()!.pairs[0]).toMatchObject({ state: 'ready' }))
    await eventually(() => expect([...w.state.membership.keys()]).toContain(`!general:test ${ghost}`))
    const token = w.state.asToken
    await first.bridge.stop()
    const second = await start(w, 'application_service', first.dataDir, null)
    await eventually(() => expect(second.report()).toMatchObject({ ready: true, pairs: [{ state: 'ready' }] }))
    expect(w.state.redeems).toHaveLength(1)
    expect(w.state.asToken).toBe(token)
    expect(w.state.joins).toEqual(['!general:test @harmony_relay:test', `!general:test ${ghost}`])
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(w.state.leaves).toEqual([])
    expect(second.lines.join('\n')).toContain('Using the saved credentials')
  }, 20_000)

  it('answers !bridge-privacy, obeys the list and Harmony\'s refusal', async () => {
    const w = await world()
    w.state.pairs = [pair()]
    w.state.optedOut = ['@gone:test']
    const { transaction, report, bridge } = await start(w, 'application_service')
    await eventually(() => expect(report()!.pairs[0]).toMatchObject({ state: 'ready' }))
    expect(w.state.privacyCalls).toEqual(['GET optouts'])
    await transaction('t1', [matrixEvent('$gone', 'from someone opted out', { room_id: '!general:test', sender: '@gone:test' }),
      matrixEvent('$ask', '!bridge-privacy opt-out', { room_id: '!general:test' }), matrixEvent('$late', 'too late', { room_id: '!general:test' })])
    await eventually(() => expect(w.state.matrixPosts).toHaveLength(1))
    expect(w.state.matrixPosts[0]).toMatchObject({ msgtype: 'm.notice', sender: '@harmony_relay:test', 'm.mentions': { user_ids: ['@alice:test'] }, 'm.relates_to': { 'm.in_reply_to': { event_id: '$ask' } } })
    expect(w.state.privacyCalls).toContain('PUT optouts/@alice:test')
    await eventually(() => expect(bridge.status().pending).toBe(0))
    expect(w.state.harmonyPosts).toEqual([])

    w.state.privacyVersion = '2'
    w.state.optedOut = []
    w.configChanged()
    await eventually(() => expect(w.state.privacyCalls.filter(call => call === 'GET optouts')).toHaveLength(2))
    w.state.refuseAuthor = true
    await transaction('t2', [matrixEvent('$a', 'refused', { room_id: '!general:test' }), matrixEvent('$b', 'not even tried', { room_id: '!general:test' })])
    await eventually(() => expect(bridge.status().pending).toBe(0))
    w.state.refuseAuthor = false
    await transaction('t3', [matrixEvent('$c', 'nor this', { room_id: '!general:test' })])
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(w.state.harmonyPosts).toEqual([])
  }, 20_000)

  it('stops relaying a pair whose room turns on encryption, and tells Harmony', async () => {
    const w = await world()
    w.state.pairs = [pair()]
    const { transaction, report } = await start(w, 'application_service')
    await eventually(() => expect(report()!.pairs[0]).toMatchObject({ state: 'ready' }))
    await eventually(() => expect(w.state.membership.get(`!general:test ${ghost}`)).toBe('join'))
    w.state.encrypted.add('!general:test')
    await transaction('t1', [{ type: 'm.room.encryption', state_key: '', event_id: '$e', room_id: '!general:test', sender: '@alice:test', content: {} }, matrixEvent('$one', 'plain', { room_id: '!general:test' })])
    w.harmonyMessage('h-native', 'to an encrypted room')
    await eventually(() => expect(w.state.leaves).toContain(`!general:test ${ghost}`))
    await eventually(() => expect(report()).toMatchObject({ pairs: [{ state: 'error', error: 'room_encrypted' }], problems: [{ code: 'room_encrypted', detail: '#general:test' }] }))
    expect(w.state.harmonyPosts).toEqual([])
    expect(w.state.matrixPosts).toEqual([])
  }, 20_000)

  it('reports refused credentials and comes back when they work again', async () => {
    const w = await world()
    w.state.pairs = [pair()]
    const { bridge, health, lines } = await start(w, 'application_service')
    await eventually(async () => expect((await health()).status).toBe(200))
    await eventually(() => expect(bridge.report().rooms).toHaveLength(1))
    w.state.configStatus = 401
    w.dropGateway()
    await eventually(async () => expect((await health()).body).toMatchObject({ ready: false, problems: ['harmony_auth_failed'] }))
    expect(bridge.report()).toMatchObject({ ready: false, rooms: [] })
    await bridge.refreshConfig()
    expect(lines.join('\n')).toContain('Make a new setup code')
    w.state.configStatus = 200
    await bridge.refreshConfig()
    await eventually(async () => expect((await health()).status).toBe(200))
    expect(w.state.identified).toBe(2)
  }, 20_000)
})

describe('a managed account', () => {
  it('syncs, relays through the account and lists the rooms it is in', async () => {
    const w = await world()
    w.state.membership.set('!other:test @community:test', 'join')
    w.state.pairs = [pair()]
    const { report, dataDir, health } = await start(w, 'account')
    await eventually(() => expect(report()).toMatchObject({ connection: 'account', ready: true, user_id: '@community:test', server_name: 'test', pairs: [{ state: 'ready', error: null }], problems: [] }))
    await eventually(() => expect(report()!.rooms.map(room => room.room_id)).toEqual(['!general:test', '!other:test']))
    expect(await health()).toMatchObject({ status: 200 })
    expect(w.state.binds[0]).toMatchObject({ initial_sender_mode: 'relay' })
    await eventually(() => expect(w.state.syncs.some(sync => sync.get('timeout') === '30000')).toBe(true))
    await eventually(() => expect(w.state.pendingSync).not.toBeNull())
    w.matrixEvents('!general:test', [matrixEvent('$one', 'hello Harmony'), matrixEvent('$own', 'own', { sender: '@community:test' })])
    await eventually(() => expect(w.state.harmonyPosts).toHaveLength(1))
    w.harmonyMessage('h-native', 'hello Matrix')
    await eventually(() => expect(w.state.matrixPosts).toHaveLength(1))
    expect(w.state.matrixPosts[0]).toMatchObject({ sender: '@community:test', body: '[Alice · Harmony] hello Matrix' })
    expect([...w.state.membership.keys()].some(key => key.includes('_h_'))).toBe(false)
    expect(() => statSync(join(dataDir, 'registration.json'))).toThrow()
  }, 20_000)

  it('relays what was said while it was stopped, and no history before it was paired', async () => {
    const w = await world()
    w.state.pairs = [pair()]
    w.state.membership.set('!general:test @community:test', 'join')
    w.state.queue.push({ room: '!general:test', events: [matrixEvent('$before', 'before the pair')] })
    const first = await start(w, 'account')
    // The room's first response is stored.
    const reader = new Store(join(first.dataDir, 'bridge.sqlite'))
    await eventually(() => expect(reader.syncState('@community:test')?.rooms).toEqual(['!general:test']))
    reader.close()
    await first.bridge.stop()
    expect(w.state.harmonyPosts).toEqual([])
    const token = w.state.queue.length
    w.state.queue.push({ room: '!general:test', events: [matrixEvent('$while', 'while stopped')] })
    await start(w, 'account', first.dataDir, null)
    await eventually(() => expect(w.state.harmonyPosts).toHaveLength(1))
    expect(w.state.harmonyPosts[0].content).toEqual([{ type: 'text', text: 'while stopped' }])
    expect(w.state.syncs.some(sync => sync.get('since') === `s${token}`)).toBe(true)
  }, 20_000)

  it('finds the client API behind the address it was given', async () => {
    const w = await world()
    w.state.wellKnown = { 'm.homeserver': { base_url: `${w.url}/client-api` } }
    const { report } = await start(w, 'account')
    await eventually(() => expect(report()).toMatchObject({ ready: true, user_id: '@community:test', homeserver: w.url }))
  }, 20_000)

  it('keeps running and says so while its token is refused', async () => {
    const w = await world()
    w.state.refuseAccount = true
    const { report, health } = await start(w, 'account')
    await eventually(() => expect(report()).toMatchObject({ connection: 'account', ready: false, user_id: null, server_name: null, problems: [{ code: 'matrix_token_invalid', detail: TOKEN_HINT }] }))
    expect((await health()).status).toBe(503)
    w.state.refuseAccount = false
    await eventually(() => expect(report()).toMatchObject({ ready: true, user_id: '@community:test', problems: [] }))
  }, 20_000)
})

describe('a homeserver that refused the service for a while', () => {
  it('is told of its user again', async () => {
    const w = await world()
    const { report } = await start(w, 'application_service')
    await eventually(() => expect(report()?.ready).toBe(true))
    expect(w.state.registers).toEqual(['harmony_relay'])
    w.state.refuseAs = true
    await eventually(() => expect(report()!.problems).toEqual([{ code: 'matrix_registration_missing' }]))
    w.state.refuseAs = false
    await eventually(() => expect(report()!.ready).toBe(true))
    expect(w.state.registers).toEqual(['harmony_relay', 'harmony_relay'])
  }, 20_000)
})

describe('ghosts from before the data was lost', () => {
  it('are taken over once the homeserver owns they are the service\'s, and refused otherwise', async () => {
    const w = await world()
    w.state.ghostsExist = true
    w.state.whoamiRefused = true
    w.state.pairs = [pair({ room_id: '!general:test' })]
    const { bridge } = await start(w, 'application_service')
    await eventually(() => expect(bridge.report().pairs).toEqual([{ channel_id: channelId, state: 'error', error: 'ghosts_unavailable' }]))
    w.harmonyMessage('h-refused', 'refused')
    await eventually(() => expect(bridge.report().failed).toBe(1))
    expect(w.state.matrixPosts).toEqual([])
    w.state.whoamiRefused = false
    w.harmonyMessage('h-taken', 'taken over')
    await eventually(() => expect(w.state.matrixPosts).toEqual([expect.objectContaining({ sender: ghost, body: 'taken over' })]))
    await eventually(() => expect(bridge.report().pairs).toEqual([{ channel_id: channelId, state: 'ready', error: null }]))
  }, 20_000)
})

describe('a bridge run by a host', () => {
  it('relays nothing while its account is another\'s, asks again, and opens no port', async () => {
    const w = await world()
    w.state.pairs = [pair({ room_id: '!general:test' })]
    w.state.membership.set('!general:test @community:test', 'join')
    let granted = false
    const claim = vi.fn(async () => granted)
    const lines: string[] = []
    const bridge = new ManagedBridge({ kind: 'managed', harmonyUrl: w.url, setupCode: null, dataDir: directory(), listen: null, ignoredConfig: null, matrix: { kind: 'account', homeserverUrl: w.url, accessToken } },
      { version: 'test', log: line => lines.push(line), warn: line => lines.push(line), timings: { configMs: 60_000, configSoonMs: 5, statusMs: 60_000, statusSoonMs: 5, roomsMs: 50, matrixMs: 100, backoffMs: 50, memberFrameMs: 20 },
        hosted: { harmony: { apiBase: `${w.url}/bot-gateway`, gatewayUrl: `${w.url.replace('http', 'ws')}/bot-gateway/gateway`, token: harmonyToken }, claim, tokenHint: 'Sign in again.', refusedHint: 'Wait.' } })
    bridges.push(bridge)
    await bridge.start()
    expect(w.state.redeems).toEqual([])
    await eventually(() => expect(w.state.statuses.at(-1)).toMatchObject({ ready: false, user_id: null, problems: [{ code: 'account_in_use' }] }))
    expect(claim).toHaveBeenCalledWith(w.url, '@community:test')
    await eventually(() => expect(claim.mock.calls.length).toBeGreaterThanOrEqual(3))
    expect([w.state.identified, w.state.syncs.length, w.state.joins.length]).toEqual([0, 0, 0])
    granted = true
    await eventually(() => expect(w.state.statuses.at(-1)).toMatchObject({ ready: true, user_id: '@community:test', problems: [] }))
    const asked = claim.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(claim.mock.calls.length).toBe(asked)
    w.state.refuseAccount = true
    await eventually(() => expect(w.state.statuses.at(-1)!.problems).toContainEqual({ code: 'matrix_token_invalid', detail: 'Sign in again.' }))
    expect(lines.filter(line => line.includes('Another bridge uses'))).toHaveLength(1)
  }, 20_000)
})

describe('what changes with the configuration', () => {
  it('has the members looked at again, opt-outs included', async () => {
    const w = await world()
    w.state.pairs = [pair({ room_id: '!general:test' })]
    const noted = vi.spyOn(Relay.prototype, 'noteConfiguration')
    const { bridge, report } = await start(w, 'application_service')
    await eventually(() => expect(report()!.pairs[0]?.state).toBe('ready'))
    await bridge.refreshConfig()
    expect(noted).not.toHaveBeenCalled()
    w.state.updatedAt = 'moved'
    await bridge.refreshConfig()
    expect(noted).toHaveBeenCalledOnce()
    noted.mockRestore()
  }, 20_000)
})

describe('local storage that fails', () => {
  it('is reported while the bridge stays up, and pairs follow once it works', async () => {
    const w = await world()
    const { report, bridge, health } = await start(w, 'application_service')
    await eventually(async () => expect((await health()).status).toBe(200))
    const broken = vi.spyOn(Store.prototype, 'prunePairStarts').mockImplementation(() => { throw new Error('disk') })
    try {
      w.state.pairs = [pair({ room_id: '!general:test' })]
      w.configChanged()
      await eventually(() => expect(report()).toMatchObject({ ready: false, problems: [{ code: 'worker_stopped' }] }))
    } finally { broken.mockRestore() }
    await bridge.refreshConfig()
    await eventually(() => expect(report()).toMatchObject({ ready: true, problems: [], pairs: [{ state: 'ready' }] }))
  }, 20_000)
  it('fails no queued message while its pairs cannot be kept', async () => {
    const w = await world()
    w.state.pairs = [pair({ room_id: '!general:test' })]
    const dataDir = directory()
    const store = new Store(join(dataDir, 'bridge.sqlite'))
    store.enqueue({ direction: 'to_harmony', sourceId: '$queued', channelId, roomId: '!general:test', payload: { sender: '@alice:test', body: 'queued' } })
    store.close()
    const broken = vi.spyOn(Store.prototype, 'prunePairStarts').mockImplementation(() => { throw new Error('disk') })
    let started: Awaited<ReturnType<typeof start>>
    try {
      started = await start(w, 'application_service', dataDir)
      await eventually(() => expect(started.report()?.problems).toContainEqual(expect.objectContaining({ code: 'worker_stopped' })))
      await new Promise(resolve => setTimeout(resolve, 600))
      expect(started.bridge.status()).toMatchObject({ ready: false, pending: 1, failed: 0 })
    } finally { broken.mockRestore() }
    await started.bridge.refreshConfig()
    await eventually(() => expect(w.state.harmonyPosts).toHaveLength(1))
  }, 20_000)
})

describe('starting', () => {
  it.each([[400, 'refused the setup code'], [404, '1.9.9']])('stops with a plain reason when the code is answered with %s', async (status, words) => {
    const w = await world()
    w.state.redeem = status
    const error = await start(w, 'application_service').catch(error => error)
    expect(error).toBeInstanceOf(FatalConfigError)
    expect(error.message).toContain(words)
    await expect(fetch(`http://127.0.0.1:${w.port}/bot-gateway/health`)).resolves.toBeDefined()
  })
  it('waits for a Harmony that does not answer yet, with /health up, and can be stopped meanwhile', async () => {
    const port = await freePort()
    const listenPort = await freePort()
    const bridge = new ManagedBridge({ kind: 'managed', harmonyUrl: `http://127.0.0.1:${port}`, setupCode: 'MX-1', dataDir: directory(), listen: { host: '127.0.0.1', port: listenPort }, ignoredConfig: null,
      matrix: { kind: 'account', homeserverUrl: `http://127.0.0.1:${port}`, accessToken } }, { version: 'test', log: () => {}, warn: () => {}, timings: { backoffMs: 50 } })
    bridges.push(bridge)
    const starting = bridge.start().catch(error => error)
    await eventually(async () => expect((await fetch(`http://127.0.0.1:${listenPort}/health`)).status).toBe(503))
    await bridge.stop()
    await starting
  }, 20_000)

  const run = (env: Record<string, string>, cwd: string) => {
    const child = spawn(process.execPath, ['--import', join(process.cwd(), 'node_modules/tsx/dist/loader.mjs'), join(process.cwd(), 'src/index.ts')], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH!, ...env } })
    children.push(child)
    const output = { text: '' }
    for (const stream of [child.stdout!, child.stderr!]) stream.on('data', chunk => { output.text += String(chunk) })
    return { child, output }
  }
  it('prints instructions and fails when nothing is configured', async () => {
    const { child, output } = run({}, directory())
    expect((await once(child, 'exit'))[0]).toBe(1)
    expect(output.text).toContain('HARMONY_URL')
    expect(output.text).toContain('MATRIX_HOMESERVER_URL')
  }, 15_000)
  it('runs from the environment, stops on SIGTERM and prints no secret', async () => {
    const w = await world()
    const port = await freePort()
    const cwd = directory()
    const { child, output } = run({ HARMONY_URL: w.url, HARMONY_SETUP_CODE: 'MX-AAAA-BBBB-CCCC', MATRIX_HOMESERVER_URL: w.url, MATRIX_ACCESS_TOKEN: accessToken, LISTEN_PORT: String(port) }, cwd)
    await eventually(async () => expect((await fetch(`http://127.0.0.1:${port}/health`)).status, output.text).toBe(200))
    expect(statSync(join(cwd, 'data', 'credentials.json')).mode & 0o777).toBe(0o600)
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    expect((await exited)[0]).toBe(0)
    for (const secret of [accessToken, harmonyToken, 'MX-AAAA']) expect(output.text).not.toContain(secret)
  }, 20_000)
})
