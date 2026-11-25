// Managed start against a real Synapse, as an application service and as an ordinary account.
// Invoked by synapse-smoke.mjs only; bot-gateway is a contract fake. No Docker resources here.
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

const channelA = '44444444-4444-4444-8444-444444444444';
const channelB = '55555555-5555-4555-8555-555555555555';
const channelC = '66666666-6666-4666-8666-666666666666';
const nativeUser = { id: '77777777-7777-4777-8777-777777777777', username: 'nadia', display_name: 'Nadia Nick', avatar_url: null, domain: 'harmony.test' };
const TIMINGS = { configMs: 60_000, configSoonMs: 20, statusMs: 60_000, statusSoonMs: 20, roomsMs: 300, matrixMs: 1_000, backoffMs: 200, memberFrameMs: 50 };

/** The shapes of bot-gateway's /bridge/v2/matrix and /api/v1 bridge routes. */
async function createGateway(listen, separate = false) {
  const token = `harmony_bot_${randomBytes(32).toString('hex')}`;
  const state = { pairs: [], privacyVersion: '1', optedOut: new Set(), statuses: [], posts: [], memberFrames: [], redeems: 0, port: 0, errors: [], separate };
  let socket;
  const server = createServer(async (req, res) => {
    const send = (body, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const base = `http://127.0.0.1:${state.port}`;
      if (path === '/bot-gateway/health') return send({ status: 'ok' });
      if (path === '/bot-gateway/bridge/v2/matrix/redeem') {
        state.redeems++;
        return send({ bridge_id: 'b', server_id: 's', harmony_token: token, base_url: base, api_url: `${base}/bot-gateway`, gateway_url: `ws://127.0.0.1:${state.port}/bot-gateway/gateway` });
      }
      if (req.headers.authorization !== `Bot ${token}`) return send({}, 401);
      const pair = state.pairs.find(candidate => path.includes(candidate.channel_id));
      if (path.endsWith('/matrix/config')) return send({ bridge_id: 'b', server_id: 's', mode: 'self', updated_at: '1', base_url: null, privacy_version: state.privacyVersion, pairs: state.pairs });
      if (path.endsWith('/matrix/status')) { state.statuses.push(input); return send({ ok: true }); }
      if (path.endsWith('/privacy/optouts')) return send({ version: state.privacyVersion, remote_user_ids: [...state.optedOut] });
      if (path.includes('/privacy/optouts/')) {
        const id = path.split('/privacy/optouts/')[1];
        if (req.method === 'PUT') state.optedOut.add(id);
        if (req.method === 'DELETE') state.optedOut.delete(id);
        return send({ opted_out: state.optedOut.has(id), since: null, source: state.optedOut.has(id) ? 'user' : null });
      }
      if (path.endsWith('/bridge-check')) {
        if (state.separate) return send({}, 404);
        const asked = new URL(req.url, 'http://localhost').searchParams.get('user_id');
        return send(!pair ? { platform: null, room_id: null, sender_mode: null, messages_encrypted: null, relay_allowed: null, member: null }
          : { platform: 'matrix', room_id: pair.room_id, sender_mode: pair.sender_mode, messages_encrypted: false, relay_allowed: asked === null ? null : true, member: asked === nativeUser.id ? nativeUser : null });
      }
      if (path.endsWith('/bridge-platform')) return send({ platform: pair ? 'matrix' : null });
      if (path.endsWith('/bridge-room')) {
        if (!pair) return send({}, 403);
        if (req.method === 'PUT') {
          if (pair.room_alias && input.room_alias !== pair.room_alias) return send({ code: 'room_changed' }, 409);
          pair.room_id = input.room_id;
        }
        return pair.room_id ? send({ room_id: pair.room_id, sender_mode: pair.sender_mode }) : send({}, 503);
      }
      if (path.endsWith('/bridge-members')) return send(pair ? [nativeUser] : [], pair ? 200 : 403);
      if (path.includes('/bridge-consent/')) return send({ relay_allowed: true });
      if (path.endsWith('/encryption')) return send({ messages_encrypted: false });
      if (path.endsWith('/messages')) {
        if (state.optedOut.has(input.metadata?.bridge_author?.id)) return send({ code: 'BRIDGE_AUTHOR_OPTED_OUT' }, 403);
        state.posts.push({ channel: pair?.channel_id, text: input.content.map(part => part.text ?? '').join(''), author: input.metadata.bridge_author.id });
        return send({ id: randomUUID() });
      }
      return send({}, 404);
    } catch {
      state.errors.push('Invalid fake Gateway request');
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', connection => {
    socket = connection;
    connection.on('message', bytes => {
      const frame = JSON.parse(bytes.toString());
      if (frame.op === 2) connection.send(JSON.stringify({ op: 0, t: 'READY', d: { heartbeat_interval: 60_000, capabilities: ['matrix_bridge_v2', ...(state.separate ? [] : ['matrix_bridge_check'])] } }));
      if (frame.op === 6) state.memberFrames.push(frame.d);
    });
  });
  state.port = await listen(server);
  return {
    state, url: `http://127.0.0.1:${state.port}`,
    pair: pairs => { state.pairs = pairs; socket?.send(JSON.stringify({ op: 0, t: 'BRIDGE_CONFIG_UPDATE', d: { bridge_id: 'b' } })); },
    say: (channelId, text) => socket.send(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', d: { id: randomUUID(), channel_id: channelId, author: { id: nativeUser.id, username: nativeUser.username },
      content: text, content_raw: [{ type: 'text', text }], metadata: {}, is_system: false } })),
    close: async () => {
      for (const connection of sockets.clients) connection.terminate();
      sockets.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

/** The registration of the managed application service, as the bridge itself writes it. */
export async function managedRegistration(dataDir, port, homeserverUrl) {
  const { serviceTokens, writeRegistration } = await import('../dist/credentials.js');
  const plan = { kind: 'application_service', homeserverUrl, serverName: 'localhost', senderLocalpart: 'managed_bridge', applicationServiceUrl: `http://127.0.0.1:${port}`, tokens: null };
  writeRegistration(plan, serviceTokens(plan, dataDir), dataDir);
  return plan;
}

export async function runManagedSmoke({ json, until, listen, freePort, homeserverUrl, user, plan, port, directory, registrationSecret, setStage }) {
  const { ManagedBridge } = await import('../dist/managed.js');
  const client = `${homeserverUrl}/_matrix/client/v3`;
  const running = new Set();
  const gateways = [];
  const path = room => `${client}/rooms/${encodeURIComponent(room)}`;
  const human = (room, body, extra = {}) => json(`${path(room)}/send/m.room.message/${randomUUID()}`, { method: 'PUT', token: user.access_token, body: { msgtype: 'm.text', body, 'm.mentions': {}, ...extra } });
  const createRoom = body => json(`${client}/createRoom`, { method: 'POST', token: user.access_token, body: { preset: 'private_chat', creation_content: { 'm.federate': false }, ...body } });
  const invite = (room, id) => json(`${path(room)}/invite`, { method: 'POST', token: user.access_token, body: { user_id: id } });
  const joined = async room => Object.keys((await json(`${path(room)}/joined_members`, { token: user.access_token })).joined);
  const recent = async room => (await json(`${path(room)}/messages?dir=b&limit=30`, { token: user.access_token })).chunk;
  const encrypt = room => json(`${path(room)}/state/m.room.encryption/`, { method: 'PUT', token: user.access_token, body: { algorithm: 'm.megolm.v1.aes-sha2' } });
  const pairOf = (channel_id, extra) => ({ channel_id, channel_name: 'smoke', room_id: null, room_alias: null, direction: 'both', sender_mode: 'ghost', encrypted: false, ...extra });
  async function launch(gateway, matrix, dataDir, listenPort, setupCode = 'MX-SMOK-EEEE-TEST') {
    const bridge = new ManagedBridge({ kind: 'managed', harmonyUrl: gateway.url, setupCode, matrix, dataDir, listen: { host: '127.0.0.1', port: listenPort }, ignoredConfig: null },
      { version: 'smoke', log: () => {}, warn: () => {}, timings: TIMINGS });
    running.add(bridge);
    await bridge.start();
    return bridge;
  }
  const stop = async bridge => { running.delete(bridge); await bridge.stop(); };
  const last = gateway => gateway.state.statuses.at(-1);
  const stateOf = (gateway, channel) => last(gateway)?.pairs.find(pair => pair.channel_id === channel);

  try {
    setStage('managed start: refused registration');
    const gateway = await createGateway(listen);
    gateways.push(gateway);
    const unknown = { asToken: randomBytes(32).toString('hex'), hsToken: randomBytes(32).toString('hex') };
    const refused = await launch(gateway, { ...plan, tokens: unknown }, join(directory, 'refused'), await freePort());
    await until(() => last(gateway)?.problems.some(problem => problem.code === 'matrix_registration_missing'));
    assert.equal(last(gateway).ready, false);
    await stop(refused);
    console.log('PASS managed start keeps running and reports matrix_registration_missing while Synapse refuses its token');

    setStage('managed application service: zero pairs, invites in the room list');
    let bridge = await launch(gateway, plan, join(directory, 'managed'), port);
    await until(() => last(gateway)?.ready === true);
    assert.deepEqual(last(gateway).pairs, []);
    assert.equal(last(gateway).user_id, '@managed_bridge:localhost');
    const { room_id: roomA } = await createRoom({ name: 'Managed room', invite: ['@managed_bridge:localhost'] });
    const { room_id: secretRoom } = await createRoom({ name: 'Secret room', invite: ['@managed_bridge:localhost'],
      initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }] });
    await until(() => last(gateway).rooms.length === 2);
    const listed = Object.fromEntries(last(gateway).rooms.map(room => [room.room_id, room]));
    assert.deepEqual(listed[roomA], { room_id: roomA, name: 'Managed room', alias: null, encrypted: false, can_send: true, members: 0, invited: true });
    assert.equal(listed[secretRoom].encrypted, true);
    assert.ok(!(await joined(roomA)).includes('@managed_bridge:localhost'));
    console.log('PASS zero pairs is a running state; real invites appear in the room list with their encryption, and none is joined unasked');

    setStage('managed application service: pair, relay, first-speech ghost');
    await human(roomA, 'said before the pair');
    gateway.pair([pairOf(channelA, { room_id: roomA })]);
    await until(() => stateOf(gateway, channelA)?.state === 'ready');
    await human(roomA, 'hello managed');
    await until(() => gateway.state.posts.length === 1);
    assert.deepEqual(gateway.state.posts, [{ channel: channelA, text: 'hello managed', author: user.user_id }]);
    gateway.say(channelA, 'hello from Harmony');
    const ghost = '@managed_bridge_h_77777777777747778777777777777777:localhost';
    await until(async () => (await recent(roomA)).some(event => event.sender === ghost && event.content.body === 'hello from Harmony'));
    console.log('PASS a paired room is joined, relays both ways through a real ghost, and copies nothing said before the pair');

    setStage('managed application service: privacy command');
    const ask = await human(roomA, '!bridge-privacy opt-out');
    await until(async () => (await recent(roomA)).some(event => event.content['m.relates_to']?.['m.in_reply_to']?.event_id === ask.event_id));
    const answer = (await recent(roomA)).find(event => event.content['m.relates_to']?.['m.in_reply_to']?.event_id === ask.event_id);
    assert.equal(answer.sender, '@managed_bridge:localhost');
    assert.equal(answer.content.msgtype, 'm.notice');
    assert.deepEqual(answer.content['m.mentions'], { user_ids: [user.user_id] });
    assert.ok(gateway.state.optedOut.has(user.user_id));
    await human(roomA, 'must not reach Harmony');
    const back = await human(roomA, '!bridge-privacy opt-in');
    await until(async () => (await recent(roomA)).some(event => event.content['m.relates_to']?.['m.in_reply_to']?.event_id === back.event_id));
    await human(roomA, 'back again');
    await until(() => gateway.state.posts.length === 2);
    assert.equal(gateway.state.posts[1].text, 'back again');
    console.log('PASS !bridge-privacy opts a real Matrix person out and in, answers as a notice to them, and relays neither the command nor what it stopped');

    setStage('managed application service: several pairs, one of them bad');
    const { room_id: roomB } = await createRoom({ preset: 'public_chat', name: 'Public room', room_alias_name: 'managed_public' });
    const { room_id: closedRoom } = await createRoom({ name: 'Closed room' });
    gateway.pair([...gateway.state.pairs, pairOf(channelB, { room_alias: '#managed_public:localhost' }), pairOf(channelC, { room_id: closedRoom })]);
    await until(() => stateOf(gateway, channelB)?.state === 'ready' && stateOf(gateway, channelC)?.state === 'error');
    assert.equal(stateOf(gateway, channelC).error, 'not_invited');
    assert.equal(stateOf(gateway, channelA).state, 'ready');
    assert.equal(gateway.state.pairs.find(pair => pair.channel_id === channelB).room_id, roomB);
    await human(roomB, 'through the alias');
    await until(() => gateway.state.posts.some(post => post.channel === channelB && post.text === 'through the alias'));
    await invite(closedRoom, '@managed_bridge:localhost');
    await until(() => stateOf(gateway, channelC)?.state === 'ready');
    console.log('PASS an alias pair is resolved, joined and bound; a room without an invite is reported alone and joins once invited');

    setStage('managed application service: restart, removal and encryption');
    await stop(bridge);
    await human(roomA, 'said while the bridge was stopped');
    bridge = await launch(gateway, plan, join(directory, 'managed'), port, null);
    await until(() => gateway.state.posts.some(post => post.text === 'said while the bridge was stopped'), 60_000);
    assert.equal(gateway.state.redeems, 2);
    const postsBeforeRemoval = gateway.state.posts.length;
    gateway.pair(gateway.state.pairs.filter(pair => pair.channel_id !== channelA));
    await until(async () => !(await joined(roomA)).includes(ghost));
    await until(() => last(gateway).pairs.length === 2);
    await human(roomA, 'after the removal');
    await encrypt(roomB);
    await until(() => stateOf(gateway, channelB)?.error === 'room_encrypted');
    await human(roomB, 'plaintext in an encrypted room');
    gateway.say(channelB, 'must not reach an encrypted room');
    await new Promise(resolve => setTimeout(resolve, 2_000));
    assert.equal(gateway.state.posts.length, postsBeforeRemoval);
    assert.ok(!(await recent(roomB)).some(event => event.content.body === 'must not reach an encrypted room'));
    assert.ok(last(gateway).problems.some(problem => problem.code === 'room_encrypted'));
    await stop(bridge);
    assert.deepEqual(gateway.state.errors, []);
    console.log('PASS restart keeps credentials and loses nothing; a removed pair\'s ghosts leave; a room that turns on encryption stops relaying');

    setStage('managed account: sign-in and room list');
    const { nonce } = await json(`${homeserverUrl}/_synapse/admin/v1/register`);
    const password = randomBytes(16).toString('hex');
    const name = `community_${randomBytes(6).toString('hex')}`;
    const mac = createHmac('sha1', registrationSecret).update(`${nonce}\0${name}\0${password}\0notadmin`).digest('hex');
    const account = await json(`${homeserverUrl}/_synapse/admin/v1/register`, { method: 'POST', body: { nonce, username: name, password, admin: false, mac } });
    // Harmony without bridge-check, by the routes of 1.9.8.
    const accountGateway = await createGateway(listen, true);
    gateways.push(accountGateway);
    const signIn = accessToken => ({ kind: 'account', homeserverUrl, accessToken });
    const accountPort = await freePort();
    const { login, LoginError } = await import('../dist/login.js');
    const said = [];
    const asking = secret => ({ address: homeserverUrl, ask: () => async (_question, hidden) => hidden ? secret : name, say: line => said.push(line) });
    await assert.rejects(login(asking('not the password')), error => error instanceof LoginError && error.message === 'Wrong user name or password.');
    const lasting = await login(asking(password));
    assert.equal((await json(`${client}/account/whoami`, { token: lasting })).user_id, account.user_id);
    assert.ok((await json(`${client}/devices`, { token: lasting })).devices.some(device => device.display_name === 'Harmony bridge'));
    assert.ok(!said.join('').includes(lasting) && !said.join('').includes(password));
    const bad = await launch(accountGateway, signIn('syt_wrong_token_0000'), join(directory, 'bad-account'), accountPort);
    await until(() => last(accountGateway)?.problems.some(problem => problem.code === 'matrix_token_invalid'));
    await stop(bad);
    const { room_id: accountRoom } = await createRoom({ name: 'Account room', invite: [account.user_id] });
    await human(accountRoom, 'history before the pair');
    let self = await launch(accountGateway, signIn(lasting), join(directory, 'account'), accountPort);
    await until(() => last(accountGateway).rooms.some(room => room.room_id === accountRoom && room.invited === true && room.encrypted === false));
    assert.equal(last(accountGateway).connection, 'account');
    console.log('PASS --login gives a real, lasting token; account mode reports a refused one, and lists a real invite without joining');

    setStage('managed account: relay without history');
    accountGateway.pair([pairOf(channelA, { room_id: accountRoom })]);
    await until(() => stateOf(accountGateway, channelA)?.state === 'ready');
    // The room's first sync response is history; the next one relays.
    await new Promise(resolve => setTimeout(resolve, 1_500));
    await human(accountRoom, 'hello account');
    await until(() => accountGateway.state.posts.length === 1);
    assert.equal(accountGateway.state.posts[0].text, 'hello account');
    accountGateway.say(channelA, 'hello from Harmony');
    await until(async () => (await recent(accountRoom)).some(event => event.sender === account.user_id && event.content.body === '[nadia · Harmony] hello from Harmony'));
    assert.deepEqual((await joined(accountRoom)).sort(), [account.user_id, user.user_id].sort());
    await new Promise(resolve => setTimeout(resolve, 1_000));
    assert.equal(accountGateway.state.posts.length, 1);
    console.log('PASS account mode relays both ways as the account alone, without history or echo');

    setStage('managed account: more missed than one sync response carries');
    await stop(self);
    const missed = Array.from({ length: 115 }, (_, index) => `missed ${index}`);
    for (const body of missed) await human(accountRoom, body);
    self = await launch(accountGateway, signIn(lasting), join(directory, 'account'), accountPort, null);
    await until(() => accountGateway.state.posts.length >= 1 + missed.length, 120_000);
    assert.deepEqual(accountGateway.state.posts.slice(1).map(post => post.text), missed);
    assert.ok(!last(accountGateway).problems.some(problem => problem.code === 'messages_skipped'));
    console.log('PASS a limited timeline is read back: 115 messages missed while stopped arrive once each, in order');

    setStage('managed account: removal from the room');
    await json(`${path(accountRoom)}/kick`, { method: 'POST', token: user.access_token, body: { user_id: account.user_id } });
    await until(() => stateOf(accountGateway, channelA)?.error === 'not_invited');
    await human(accountRoom, 'said while it was out of the room');
    await invite(accountRoom, account.user_id);
    await until(() => stateOf(accountGateway, channelA)?.state === 'ready');
    await new Promise(resolve => setTimeout(resolve, 1_500));
    await human(accountRoom, 'said after its return');
    await until(() => accountGateway.state.posts.length >= 2 + missed.length);
    assert.equal(accountGateway.state.posts.at(-1).text, 'said after its return');
    assert.equal(accountGateway.state.posts.length, 2 + missed.length);
    console.log('PASS a removed account does not rejoin unasked, and copies nothing said while it was out of the room');

    setStage('managed account: encryption');
    await encrypt(accountRoom);
    await until(() => stateOf(accountGateway, channelA)?.error === 'room_encrypted');
    accountGateway.say(channelA, 'must not reach an encrypted room');
    await human(accountRoom, 'plaintext in an encrypted room');
    await new Promise(resolve => setTimeout(resolve, 2_000));
    assert.equal(accountGateway.state.posts.length, 2 + missed.length);
    assert.ok(!(await recent(accountRoom)).some(event => event.content.body?.includes('must not reach an encrypted room')));
    assert.deepEqual(accountGateway.state.errors, []);
    console.log('PASS a fence from /sync stops an account\'s pair in both directions');
  } finally {
    for (const bridge of running) await bridge.stop().catch(() => {});
    for (const gateway of gateways) await gateway.close().catch(() => {});
  }
}
