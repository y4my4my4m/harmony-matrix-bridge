// Bridge host (BRIDGE_MODE=host) against a real Synapse: a hosted account behind .well-known, and the
// instance's connection as an application service and as an account. Invoked by synapse-smoke.mjs only;
// bot-gateway is a contract fake. No Docker resources here.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';

const exec = promisify(execFile);
const LOCALPART = 'instance_bridge';
const bot = `@${LOCALPART}:localhost`;
const nadia = { id: '77777777-7777-4777-8777-777777777777', username: 'nadia', display_name: 'Nadia Nick', avatar_url: null, domain: 'harmony.test' };
const otto = { id: '88888888-8888-4888-8888-888888888888', username: 'otto', display_name: 'Otto', avatar_url: null, domain: 'harmony.test' };
const ghostOf = person => `@${LOCALPART}_h_${person.id.replaceAll('-', '')}:localhost`;
const idOf = index => `99999999-9999-4999-8999-${String(index).padStart(12, '0')}`;
const channelOf = name => `22222222-2222-4222-8222-${name.charCodeAt(0).toString(16).padStart(12, '0')}`;
const TIMINGS = { configMs: 1_000, configSoonMs: 20, statusMs: 1_000, statusSoonMs: 20, roomsMs: 300, memberFrameMs: 50, matrixMs: 1_000, backoffMs: 200, pollMs: 500, hostStatusMs: 300, healthyMs: 60_000, hostedHealthMs: 200,
  linkMs: 60_000, sweepMs: 300, holdMs: 10_000, restartMs: 500 };

/** Written before Synapse starts: the registration an administrator downloads. */
export async function instanceRegistration(directory, port) {
  const { registration } = await import('../dist/config.js');
  const tokens = { asToken: randomBytes(32).toString('hex'), hsToken: randomBytes(32).toString('hex') };
  const file = registration({ matrix: { serverName: 'localhost', senderLocalpart: LOCALPART, applicationServiceUrl: `http://127.0.0.1:${port}` } }, tokens);
  await mkdir(join(directory, 'instance'), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'instance', 'registration.json'), JSON.stringify(file), { mode: 0o600 });
  return { ...tokens, port };
}

/** The host routes and the bots of several servers' bridges. */
async function createGateway(listen, secret) {
  const bridges = new Map();
  const state = { hosted: [], instance: null, codes: new Map(), links: [], statuses: [], errors: [], port: 0 };
  const addBridge = (name, index) => {
    const bridge = { name, id: idOf(index), token: `harmony_bot_${name}_${randomBytes(16).toString('hex')}`, pairs: [], people: [nadia], optedOut: new Set(), privacyVersion: '1', statuses: [], posts: [], socket: null };
    bridges.set(name, bridge);
    return bridge;
  };
  const server = createServer(async (req, res) => {
    const send = (body, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = decodeURIComponent(url.pathname);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      if (path === '/bot-gateway/health') return send({ status: 'ok' });
      if (path.startsWith('/bot-gateway/bridge/v2/matrix/host')) {
        if (req.headers['x-bridge-host-secret'] !== secret) return send({}, 401);
        if (path.endsWith('/host/status')) { state.statuses.push(input); return send({ ok: true }); }
        if (path.endsWith('/host/link')) {
          state.links.push(input);
          const code = state.codes.get(input.code);
          if (!code) return send({ code: 'invalid_code' }, 400);
          state.codes.delete(input.code);
          for (const bridge of bridges.values()) for (const pair of bridge.pairs) if (pair.room_id === input.room_id) pair.room_id = null;
          const bridge = bridges.get(code);
          bridge.pairs = [{ channel_id: channelOf(code), channel_name: code, room_id: input.room_id, room_alias: null, direction: 'both', sender_mode: 'ghost', encrypted: false }];
          return send({ bridge_id: bridge.id, server_name: `Server ${code}`, channel_id: channelOf(code), channel_name: code });
        }
        return send({ hosted: state.hosted, instance: state.instance && { ...state.instance, bridges: state.instance.bridges.map(name => ({ bridge_id: bridges.get(name).id, harmony_token: bridges.get(name).token })) } });
      }
      const bridge = [...bridges.values()].find(candidate => req.headers.authorization === `Bot ${candidate.token}`);
      if (!bridge) return send({}, 401);
      const pair = bridge.pairs.find(candidate => path.includes(candidate.channel_id));
      const people = bridge.people.filter(person => !bridge.optedOut.has(person.id));
      if (path.endsWith('/matrix/config')) return send({ bridge_id: bridge.id, server_id: bridge.name, mode: 'instance', updated_at: JSON.stringify([bridge.pairs, [...bridge.optedOut]]), base_url: null, privacy_version: bridge.privacyVersion, pairs: bridge.pairs });
      if (path.endsWith('/matrix/status')) { bridge.statuses.push(input); return send({ ok: true }); }
      if (path.endsWith('/privacy/optouts')) return send({ version: bridge.privacyVersion, remote_user_ids: [] });
      if (path.endsWith('/bridge-check')) {
        const asked = url.searchParams.get('user_id');
        return send(!pair ? { platform: null, room_id: null, sender_mode: null, messages_encrypted: null, relay_allowed: null, member: null }
          : { platform: 'matrix', room_id: pair.room_id, sender_mode: pair.sender_mode, messages_encrypted: false, relay_allowed: asked === null ? null : !bridge.optedOut.has(asked), member: people.find(person => person.id === asked) ?? null });
      }
      if (path.endsWith('/bridge-room')) return req.method === 'PUT' ? send({ room_id: (pair.room_id = input.room_id), sender_mode: pair.sender_mode }) : send({ room_id: pair?.room_id ?? null, sender_mode: 'ghost' });
      if (path.endsWith('/bridge-members')) return send(people);
      if (path.endsWith('/messages')) { bridge.posts.push(input.content.map(part => part.text ?? '').join('')); return send({ id: randomUUID() }); }
      return send({}, 404);
    } catch {
      state.errors.push('Invalid fake Gateway request');
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', connection => {
    connection.on('message', bytes => {
      const frame = JSON.parse(bytes.toString());
      if (frame.op !== 2) return;
      const bridge = [...bridges.values()].find(candidate => candidate.token === frame.d.token);
      if (!bridge) return connection.close(4004, 'Invalid token');
      bridge.socket = connection;
      connection.send(JSON.stringify({ op: 0, t: 'READY', d: { heartbeat_interval: 60_000, capabilities: ['matrix_bridge_v2', 'matrix_bridge_check'] } }));
    });
  });
  state.port = await listen(server);
  return {
    state, bridges, addBridge, url: `http://127.0.0.1:${state.port}`,
    say: (name, text, person = nadia) => bridges.get(name).socket.send(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', d: { id: randomUUID(), channel_id: channelOf(name), author: { id: person.id, username: person.username },
      content: text, content_raw: [{ type: 'text', text }], metadata: {}, is_system: false } })),
    changed: name => bridges.get(name).socket?.send(JSON.stringify({ op: 0, t: 'BRIDGE_CONFIG_UPDATE', d: { bridge_id: bridges.get(name).id } })),
    close: async () => {
      for (const connection of sockets.clients) connection.terminate();
      sockets.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

export async function runHostSmoke({ json, until, listen, freePort, homeserverUrl, user, instance, directory, registrationSecret, setStage }) {
  const client = `${homeserverUrl}/_matrix/client/v3`;
  const closing = [];
  const hosts = new Set();
  const path = room => `${client}/rooms/${encodeURIComponent(room)}`;
  const human = (room, body, token = user.access_token) => json(`${path(room)}/send/m.room.message/${randomUUID()}`, { method: 'PUT', token, body: { msgtype: 'm.text', body, 'm.mentions': {} } });
  const createRoom = body => json(`${client}/createRoom`, { method: 'POST', token: user.access_token, body: { preset: 'private_chat', creation_content: { 'm.federate': false }, ...body } });
  const joined = async room => Object.keys((await json(`${path(room)}/joined_members`, { token: user.access_token })).joined);
  const recent = async room => (await json(`${path(room)}/messages?dir=b&limit=50`, { token: user.access_token })).chunk;
  const said = async (room, body, sender) => (await recent(room)).some(event => event.content.body === body && (!sender || event.sender === sender));
  const notice = async (room, words) => (await recent(room)).filter(event => event.type === 'm.room.message' && event.content.msgtype === 'm.notice' && event.content.body.includes(words));
  const register = async prefix => {
    const { nonce } = await json(`${homeserverUrl}/_synapse/admin/v1/register`);
    const name = `${prefix}_${randomBytes(6).toString('hex')}`;
    const password = randomBytes(16).toString('hex');
    const mac = createHmac('sha1', registrationSecret).update(`${nonce}\0${name}\0${password}\0notadmin`).digest('hex');
    return json(`${homeserverUrl}/_synapse/admin/v1/register`, { method: 'POST', body: { nonce, username: name, password, admin: false, mac } });
  };
  const secret = randomBytes(32).toString('hex');
  const gateway = await createGateway(listen, secret);
  closing.push(gateway.close);
  const { state, bridges } = gateway;
  const last = name => bridges.get(name).statuses.at(-1);
  const isReady = name => last(name)?.ready === true && last(name).pairs.length === 1 && last(name).pairs[0].state === 'ready';

  // Two https addresses: one names the homeserver in .well-known, the other is it.
  const tlsDirectory = join(directory, 'tls');
  await mkdir(tlsDirectory, { mode: 0o700 });
  const certificate = join(tlsDirectory, 'cert.pem');
  await exec('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', join(tlsDirectory, 'key.pem'), '-out', certificate]);
  const tls = { key: await readFile(join(tlsDirectory, 'key.pem')), cert: await readFile(certificate) };
  const connections = { named: 0, api: 0 };
  const proxy = createTlsServer(tls, (req, res) => {
    const upstream = request(`${homeserverUrl}${req.url}`, { method: req.method, headers: { ...req.headers, host: new URL(homeserverUrl).host } }, answer => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  proxy.on('connection', () => { connections.api++; });
  const apiPort = await listen(proxy);
  // Takes connections and never answers.
  const silent = createTlsServer(tls, () => {});
  const silentPort = await listen(silent);
  const named = createTlsServer(tls, (req, res) => {
    const found = req.url === '/.well-known/matrix/client';
    res.writeHead(found ? 200 : 404, { 'Content-Type': 'application/json' }).end(JSON.stringify(found ? { 'm.homeserver': { base_url: `https://127.0.0.1:${apiPort}` } } : {}));
  });
  named.on('connection', () => { connections.named++; });
  const namedPort = await listen(named);
  for (const server of [proxy, named, silent]) closing.push(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

  // The real entry point but for its intervals.
  const runner = join(directory, 'host-runner.mjs');
  await writeFile(runner, `
    import { guardProcess, watchEventLoop } from '${new URL('../dist/Boundary.js', import.meta.url)}'
    import { BridgeHost } from '${new URL('../dist/BridgeHost.js', import.meta.url)}'
    import { planLaunch } from '${new URL('../dist/env.js', import.meta.url)}'
    process.umask(0o077)
    const host = new BridgeHost(planLaunch(process.env, null), { version: 'smoke', timings: ${JSON.stringify(TIMINGS)} })
    guardProcess((id, error) => host.crashed(id, error), line => console.error(line))
    watchEventLoop()
    process.once('SIGTERM', () => { host.stop().then(() => process.exit(0), () => process.exit(1)) })
    await host.start()
  `, { mode: 0o600 });
  let output = '';
  async function launch(dataDir, extra = {}) {
    const child = spawn(process.execPath, [runner], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, BRIDGE_MODE: 'host', HARMONY_URL: gateway.url, HARMONY_PUBLIC_URL: 'https://harmony.test', BRIDGE_HOST_SECRET: secret,
      DATA_DIR: join(directory, dataDir), LISTEN_HOST: '127.0.0.1', LISTEN_PORT: String(instance.port), NODE_EXTRA_CA_CERTS: certificate, ...extra } });
    hosts.add(child);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${instance.port}/health`)).ok; } catch { return false; } });
    return child;
  }
  async function stop(child) {
    hosts.delete(child);
    child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    assert.equal(child.exitCode, 0);
  }

  try {
    setStage('hosted account: a private address');
    gateway.addBridge('h', 1);
    gateway.addBridge('i', 2);
    const community = await register('hosted');
    const entry = name => ({ bridge_id: bridges.get(name).id, harmony_token: bridges.get(name).token, homeserver_url: `https://localhost:${namedPort}`, access_token: community.access_token });
    const { room_id: hostedRoom } = await createRoom({ name: 'Hosted room', invite: [community.user_id] });
    state.hosted = [entry('h')];
    let host = await launch('host');
    await until(() => last('h')?.problems.some(problem => problem.code === 'matrix_unreachable'));
    await new Promise(resolve => setTimeout(resolve, 1_500));
    assert.deepEqual(connections, { named: 0, api: 0 });
    await stop(host);
    console.log('PASS a hosted bridge whose homeserver resolves to a private address connects to nothing and reports matrix_unreachable');

    setStage('hosted account: .well-known, relay');
    host = await launch('host', { MATRIX_ALLOW_PRIVATE_HOMESERVERS: 'true' });
    await until(() => last('h')?.ready === true && last('h').rooms.some(room => room.room_id === hostedRoom && room.invited === true));
    assert.ok(connections.named > 0 && connections.api > 0);
    assert.equal(last('h').user_id, community.user_id);
    bridges.get('h').pairs = [{ channel_id: channelOf('h'), channel_name: 'h', room_id: hostedRoom, room_alias: null, direction: 'both', sender_mode: 'ghost', encrypted: false }];
    gateway.changed('h');
    await until(() => isReady('h'));
    await new Promise(resolve => setTimeout(resolve, 1_500));
    await human(hostedRoom, 'hello hosted');
    await until(() => bridges.get('h').posts.includes('hello hosted'));
    gateway.say('h', 'from Harmony');
    await until(() => said(hostedRoom, '[nadia · Harmony] from Harmony', community.user_id));
    await until(() => state.statuses.at(-1)?.hosted === 1);
    console.log('PASS a hosted bridge finds its homeserver through .well-known over https and relays both ways in its own thread');

    setStage('hosted account: one bridge per account');
    state.hosted = [entry('h'), entry('i')];
    await until(() => last('i')?.problems.some(problem => problem.code === 'account_in_use'));
    assert.equal(last('i').ready, false);
    assert.equal(bridges.get('i').socket, null);
    state.hosted = [entry('i')];
    await until(() => last('i')?.ready === true);
    // From here on beside everything else: a homeserver that hangs.
    gateway.addBridge('k', 3);
    state.hosted = [{ ...entry('k'), homeserver_url: `https://localhost:${silentPort}` }];
    await until(() => state.statuses.at(-1)?.hosted === 1 && bridges.get('i').socket.readyState === 3);
    console.log('PASS a second bridge with the same account relays nothing, says account_in_use, and takes over when the first is gone');

    setStage('instance application service: two servers');
    for (const [index, name] of ['a', 'b', 'c'].entries()) gateway.addBridge(name, 10 + index);
    bridges.get('a').people = [nadia, otto];
    state.codes.set('ML-AAAA-AAAA-AAAA', 'a');
    state.codes.set('ML-BBBB-BBBB-BBBB', 'b');
    state.codes.set('ML-CCCC-CCCC-CCCC', 'c');
    state.instance = { connection: 'application_service', homeserver_url: homeserverUrl, server_name: 'localhost', sender_localpart: LOCALPART, as_token: instance.asToken, hs_token: instance.hsToken, access_token: null, bridges: ['a', 'b'] };
    await until(() => state.statuses.at(-1)?.instance?.ready === true);
    const { room_id: roomA } = await createRoom({ name: 'Room A', invite: [bot] });
    const { room_id: roomB } = await createRoom({ name: 'Room B', invite: [bot], room_version: '12', preset: 'private_chat' });
    await until(async () => (await joined(roomA)).includes(bot) && (await joined(roomB)).includes(bot));
    const guest = await register('guest');
    await json(`${path(roomA)}/invite`, { method: 'POST', token: user.access_token, body: { user_id: guest.user_id } });
    await json(`${client}/join/${encodeURIComponent(roomA)}`, { method: 'POST', token: guest.access_token, body: {} });
    await human(roomA, '!harmony link ML-AAAA-AAAA-AAAA', guest.access_token);
    await until(async () => (await notice(roomA, 'Only someone who may change')).length === 1);
    assert.deepEqual(state.links, []);
    await human(roomA, 'said before the link');
    await human(roomA, '!harmony link ml-aaaa-aaaa-aaaa');
    await until(async () => (await notice(roomA, 'now linked with #a on Server a')).length === 1);
    await human(roomB, '!harmony link ML-BBBB-BBBB-BBBB');
    await until(async () => (await notice(roomB, 'now linked with #b on Server b')).length === 1);
    assert.deepEqual(state.links.map(link => [link.code, link.room_id, link.sender]), [['ML-AAAA-AAAA-AAAA', roomA, user.user_id], ['ML-BBBB-BBBB-BBBB', roomB, user.user_id]]);
    await until(() => isReady('a') && isReady('b'));
    console.log('PASS the account joins on invitation; a code counts from who may change the room (creators of room version 12 too), and from nobody else');

    setStage('instance application service: relay');
    await human(roomA, 'to a');
    await human(roomB, 'to b');
    await until(() => bridges.get('a').posts.includes('to a') && bridges.get('b').posts.includes('to b'));
    gateway.say('a', 'from a');
    gateway.say('b', 'from b');
    await until(async () => await said(roomA, 'from a', ghostOf(nadia)) && await said(roomB, 'from b', ghostOf(nadia)));
    await until(async () => (await joined(roomA)).includes(ghostOf(otto)));
    assert.deepEqual([bridges.get('a').posts, bridges.get('b').posts], [['to a'], ['to b']]);
    assert.ok(!(await joined(roomB)).includes(ghostOf(otto)));
    assert.deepEqual(last('a').rooms.map(room => room.name), ['Room A']);
    assert.equal(last('a').user_id, bot);
    console.log('PASS two servers on one connection each get their own room, and share one Matrix user of a person who is in both');

    setStage('instance application service: opt-out in one server');
    bridges.get('a').optedOut.add(nadia.id);
    gateway.say('a', 'must not reach Matrix');
    gateway.say('b', 'reaches Matrix');
    await until(() => said(roomB, 'reaches Matrix', ghostOf(nadia)));
    gateway.changed('a');
    await until(async () => !(await joined(roomA)).includes(ghostOf(nadia)), 60_000);
    assert.ok((await joined(roomB)).includes(ghostOf(nadia)));
    assert.ok(!await said(roomA, 'must not reach Matrix'));
    console.log('PASS an opt-out in one server silences a person there, takes their Matrix user out of that room, and leaves the other server\'s alone');

    setStage('instance application service: a room moves');
    state.instance.bridges = ['a', 'b', 'c'];
    await human(roomA, '!harmony link ML-CCCC-CCCC-CCCC');
    await until(async () => (await notice(roomA, 'now linked with #c on Server c')).length === 1);
    await until(() => isReady('c') && last('a').pairs.length === 0);
    await human(roomA, 'to c');
    await until(() => bridges.get('c').posts.includes('to c'));
    gateway.say('c', 'from c');
    await until(() => said(roomA, 'from c', ghostOf(nadia)));
    await until(async () => !(await joined(roomA)).includes(ghostOf(otto)));
    gateway.say('a', 'must not reach the moved room', otto);
    await new Promise(resolve => setTimeout(resolve, 2_000));
    assert.ok((await joined(roomA)).includes(bot));
    assert.ok(!await said(roomA, 'must not reach the moved room'));
    assert.deepEqual(bridges.get('a').posts, ['to a']);
    console.log('PASS a later code moves a room to another server: the account stays, the first server\'s people leave, its messages stay out');

    setStage('instance application service: encrypted rooms');
    const { room_id: secretRoom } = await createRoom({ name: 'Secret', invite: [bot], initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }] });
    const ownMembership = async room => (await json(`${path(room)}/state/m.room.member/${encodeURIComponent(bot)}`, { token: user.access_token }));
    await until(async () => (await ownMembership(secretRoom)).membership === 'leave');
    const { room_id: laterRoom } = await createRoom({ name: 'Later secret', invite: [bot] });
    await until(async () => (await joined(laterRoom)).includes(bot));
    await json(`${path(laterRoom)}/state/m.room.encryption/`, { method: 'PUT', token: user.access_token, body: { algorithm: 'm.megolm.v1.aes-sha2' } });
    await until(async () => (await ownMembership(laterRoom)).membership === 'leave');
    assert.match((await ownMembership(laterRoom)).reason, /end-to-end encrypted/);
    assert.equal((await notice(laterRoom, 'end-to-end encrypted')).length, 1);
    console.log('PASS an encrypted room is declined, one that becomes encrypted is left, with the reason');

    setStage('instance application service: lost data, removed pair');
    assert.ok((await joined(roomB)).includes(ghostOf(nadia)));
    await until(() => last('k')?.problems.some(problem => problem.code === 'matrix_unreachable'), 60_000);
    const stopping = Date.now();
    await stop(host);
    assert.ok(Date.now() - stopping < 15_000);
    state.hosted = [];
    host = await launch('host-after-a-restore', { MATRIX_ALLOW_PRIVATE_HOMESERVERS: 'true' });
    await until(() => isReady('b') && isReady('c'));
    gateway.say('b', 'after the restore');
    await until(() => said(roomB, 'after the restore', ghostOf(nadia)), 60_000);
    assert.ok(!last('b').pairs.some(pair => pair.error));
    await human(roomB, 'still there');
    await until(() => bridges.get('b').posts.includes('still there'), 60_000);
    bridges.get('b').pairs = [];
    gateway.changed('b');
    await until(async () => !(await joined(roomB)).includes(bot) && !(await joined(roomB)).includes(ghostOf(nadia)));
    assert.ok((await joined(roomA)).includes(bot));
    console.log('PASS a hosted bridge whose homeserver hangs reports it and holds up neither the others nor the host\'s stop');
    console.log('PASS with its data lost the host takes its ghosts over and goes on; a room whose pair is removed is left by them and the account');

    setStage('instance account');
    const own = await register('instance_account');
    state.codes.set('ML-DDDD-DDDD-DDDD', 'b');
    const links = state.links.length;
    state.instance = { connection: 'account', homeserver_url: homeserverUrl, server_name: null, sender_localpart: null, as_token: null, hs_token: null, access_token: own.access_token, bridges: ['b', 'c'] };
    bridges.get('c').pairs = [];
    await until(() => state.statuses.at(-1)?.instance?.ready === true && state.statuses.at(-1).instance.user_id === own.user_id);
    const { room_id: roomD } = await createRoom({ name: 'Room D', invite: [own.user_id] });
    await until(async () => (await joined(roomD)).includes(own.user_id));
    await human(roomD, '!harmony link ML-DDDD-DDDD-DDDD');
    await until(async () => (await notice(roomD, 'now linked with #b on Server b')).length === 1);
    assert.equal(state.links.length, links + 1);
    await until(() => isReady('b'));
    await new Promise(resolve => setTimeout(resolve, 1_500));
    await human(roomD, 'to the account');
    await until(() => bridges.get('b').posts.includes('to the account'));
    gateway.say('b', 'from the account');
    await until(() => said(roomD, '[nadia · Harmony] from the account', own.user_id));
    assert.deepEqual((await joined(roomD)).sort(), [own.user_id, user.user_id].sort());
    assert.ok((await joined(roomA)).includes(bot));
    state.instance = null;
    await until(() => state.statuses.at(-1)?.instance === null);
    await new Promise(resolve => setTimeout(resolve, 1_500));
    assert.ok((await joined(roomD)).includes(own.user_id));
    await stop(host);
    console.log('PASS the instance\'s connection as an ordinary account links by code and relays; turned off it leaves nothing');

    for (const hidden of [secret, instance.asToken, instance.hsToken, community.access_token, own.access_token, 'harmony_bot_', 'ML-', 'ml-', user.user_id, community.user_id, 'from a', 'to a', roomA]) assert.ok(!output.includes(hidden));
    assert.deepEqual(state.errors, []);
    console.log('PASS the host\'s log holds no token, code, message or person');
  } catch (error) {
    if (process.env.HOST_SMOKE_DEBUG) console.error(output, error, JSON.stringify(state.statuses.at(-1)), JSON.stringify([...bridges].map(([name, bridge]) => [name, bridge.posts, bridge.statuses.at(-1)]), null, 1));
    throw error;
  } finally {
    for (const child of hosts) child.kill('SIGKILL');
    for (const close of closing) await close().catch(() => {});
  }
}
