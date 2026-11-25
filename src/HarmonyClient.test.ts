import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HarmonyClient } from './HarmonyClient.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function client(fetchImpl = vi.fn<typeof fetch>(), gatewayUrl = 'ws://localhost:1') {
  const result = new HarmonyClient({ apiUrl: 'https://harmony.example/bot-gateway', gatewayUrl, token: 'SECRET', fetchImpl, reconnectMs: 15 });
  cleanups.push(() => result.stop());
  return result;
}
async function gateway() {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  cleanups.push(() => { for (const socket of server.clients) socket.terminate(); server.close(); });
  const address = server.address() as { port: number };
  return { server, url: `ws://127.0.0.1:${address.port}` };
}
const message = { id: 'message', channel_id: 'channel', author: { id: 'user' }, content: 'hello', content_raw: [{ type: 'text', text: 'hello' }], metadata: {}, is_system: false };

describe('HarmonyClient', () => {
  it('sends structured text, metadata and Bot auth without retries', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'sent' }));
    await expect(client(fetchImpl).sendMessage('channel/a', '@everyone hi', { matrix: 'event' })).resolves.toEqual({ id: 'sent' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://harmony.example/bot-gateway/api/v1/channels/channel%2Fa/messages');
    expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bot SECRET' } });
    expect(JSON.parse(init!.body as string)).toEqual({ content: [{ type: 'text', text: '@everyone hi' }], metadata: { matrix: 'event' } });
    fetchImpl.mockRejectedValue(new Error('SECRET'));
    await expect(client(fetchImpl).sendMessage('channel', 'hello', {})).rejects.toThrow('HTTP transport failed');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('checks reply targets through permission/consent-filtered history in the exact channel', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const harmony = client(fetchImpl);
    fetchImpl.mockResolvedValueOnce(Response.json({ id: 'parent/a', channel_id: 'channel' }));
    await expect(harmony.canReplyTo('channel', 'parent/a')).resolves.toBe(true);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/messages/parent%2Fa');
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('GET');
    for (const body of [{ id: 'parent/a', channel_id: 'other' }, { id: 'other', channel_id: 'channel' }, {}]) {
      fetchImpl.mockResolvedValueOnce(Response.json(body));
      await expect(harmony.canReplyTo('channel', 'parent/a')).resolves.toBe(false);
    }
    for (const status of [403, 404]) {
      fetchImpl.mockResolvedValueOnce(Response.json({}, { status }));
      await expect(harmony.canReplyTo('channel', 'parent/a')).resolves.toBe(false);
    }
    fetchImpl.mockResolvedValueOnce(Response.json({}, { status: 503 }));
    await expect(harmony.canReplyTo('channel', 'parent/a')).rejects.toThrow();
  });

  it('posts the optional native reply pointer without changing the content or author metadata', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'reply' }));
    await client(fetchImpl).sendMessage('channel', 'New text', { bridge_author: { platform: 'matrix' } }, 'parent');
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toEqual({ content: [{ type: 'text', text: 'New text' }],
      metadata: { bridge_author: { platform: 'matrix' } }, reply_to: 'parent' });
  });

  it('downloads by stored raw attachment index with Bot auth, not supplied storage URLs', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('private bytes', { headers: {
      'Content-Type': 'application/octet-stream', 'X-File-Type': 'application/pdf', 'X-File-Name': encodeURIComponent('写真.pdf') } }));
    await expect(client(fetchImpl).downloadFile('channel/a', 'message/b', 2)).resolves.toEqual({ bytes: Buffer.from('private bytes'), contentType: 'application/pdf', name: '写真.pdf' });
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://harmony.example/bot-gateway/api/v1/channels/channel%2Fa/messages/message%2Fb/bridge-files/2');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bot SECRET' }, redirect: 'error' });
    await expect(client(fetchImpl).downloadFile('channel', 'message', -1)).rejects.toThrow('Invalid attachment index');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('uploads raw media with encoded metadata and preserves the canonical server file part', async () => {
    const part = { type: 'file', path: 'c/channel/bridge/bot/hash.pdf', url: 'https://storage.test/private/file?token=signed',
      fileType: 'file', fileName: '写真.pdf', fileSize: 7, mimeType: 'application/pdf' };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...part, untrusted: 'dropped' }));
    await expect(client(fetchImpl).uploadFile('channel', { bytes: Buffer.from('content'), name: '写真.pdf', contentType: 'application/pdf' })).resolves.toEqual(part);
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://harmony.example/bot-gateway/api/v1/channels/channel/bridge-files');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { Authorization: 'Bot SECRET', 'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent('写真.pdf'), 'X-File-Type': 'application/pdf' }, body: Buffer.from('content'), redirect: 'error' });
  });

  it.each([{ path: 'c/other/bridge/bot/hash.pdf' }, { path: 'c/channel/bridge/bot/../hash.pdf' }, { url: 'javascript:SECRET' }, { fileSize: 52428801 },
    { fileName: '../secret.pdf' }, { mimeType: 'image/png\r\nSECRET' }, { type: 'url' }, { fileType: 'video' }])('rejects malformed uploaded attachment responses %j', async invalid => {
    const part = { type: 'file', path: 'c/channel/bridge/bot/hash.pdf', url: 'https://storage.test/file', fileType: 'file', fileName: 'file.pdf', fileSize: 1, mimeType: 'application/pdf', ...invalid };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(part));
    await expect(client(fetchImpl).uploadFile('channel', { bytes: Buffer.from('x'), name: 'file.pdf', contentType: 'application/pdf' })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('requires authoritative boolean encryption state', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const harmony = client(fetchImpl);
    for (const encrypted of [true, false]) {
      fetchImpl.mockResolvedValueOnce(Response.json({ messages_encrypted: encrypted }));
      await expect(harmony.channelIsPlaintext('channel')).resolves.toBe(!encrypted);
    }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/api/v1/channels/channel/encryption');
    for (const body of [{}, { messages_encrypted: null }, { messages_encrypted: 'false' }]) {
      fetchImpl.mockResolvedValueOnce(Response.json(body));
      await expect(harmony.channelIsPlaintext('channel')).rejects.toThrow('Unknown Harmony channel encryption state');
    }
    fetchImpl.mockResolvedValueOnce(Response.json({}, { status: 503 }));
    await expect(harmony.channelIsPlaintext('channel')).rejects.toThrow();
  });

  it('requires Matrix registration, rejecting ordinary/unregistered bots and unknown platforms', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const harmony = client(fetchImpl);
    fetchImpl.mockResolvedValueOnce(Response.json({ platform: 'matrix' }));
    await expect(harmony.requireMatrixBridge('channel/a')).resolves.toBeUndefined();
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/channels/channel%2Fa/bridge-platform');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { Authorization: 'Bot SECRET' } });
    for (const body of [{ platform: null }, { platform: 'discord' }, {}, { platform: true }]) {
      fetchImpl.mockResolvedValueOnce(Response.json(body));
      await expect(harmony.requireMatrixBridge('channel')).rejects.toThrow();
    }
    fetchImpl.mockResolvedValueOnce(Response.json({}, { status: 503 }));
    await expect(harmony.requireMatrixBridge('channel')).rejects.toThrow();
  });

  it('only accepts explicit per-member relay consent and fails closed on unavailable policy', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const harmony = client(fetchImpl);
    for (const value of [true, false, null, undefined, 'true', 1]) {
      fetchImpl.mockResolvedValueOnce(Response.json({ relay_allowed: value }));
      await expect(harmony.relayAllowed('channel/a', 'user/b')).resolves.toBe(value === true);
    }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/channels/channel%2Fa/bridge-consent/user%2Fb');
    for (const status of [403, 404, 503]) {
      fetchImpl.mockResolvedValueOnce(Response.json({}, { status }));
      await expect(harmony.relayAllowed('channel', 'user')).rejects.toThrow();
    }
  });

  it('uploads bounded Matrix images through the registered Gateway endpoint with Bot auth', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ avatar_url: 'https://storage.test/storage/v1/object/public/avatars/bridges/bot/hash.png' }));
    const image = { data: 'aW1hZ2U=', content_type: 'image/png' };
    await expect(client(fetchImpl).uploadBridgeAvatar('channel/a', image)).resolves.toContain('/avatars/bridges/');
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/channels/channel%2Fa/bridge-avatar');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { Authorization: 'Bot SECRET' }, body: JSON.stringify(image) });
    for (const avatar_url of ['mxc://test/a', 'javascript:alert(1)', 'https://user:secret@host/a', 'https://host/a?token=secret', 'http://host/a', null]) {
      fetchImpl.mockResolvedValueOnce(Response.json({ avatar_url }));
      await expect(client(fetchImpl).uploadBridgeAvatar('channel', image)).rejects.toThrow();
    }
  });

  it('binds an initial sender mode but accepts the authoritative DB mode afterward', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ room_id: '!room:test', sender_mode: 'relay' }));
    const harmony = client(fetchImpl);
    await expect(harmony.bridgeRoom('channel', { room_id: '!room:test', initial_sender_mode: 'ghost' })).resolves.toEqual({ room_id: '!room:test', sender_mode: 'relay' });
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('PUT');
    await harmony.bridgeRoom('channel');
    expect(fetchImpl.mock.calls[1][1]?.method).toBe('GET');
    fetchImpl.mockResolvedValueOnce(Response.json({ room_id: '!room:test', sender_mode: 'anything' }));
    await expect(harmony.bridgeRoom('channel')).rejects.toThrow();
  });

  it('reads trusted native avatar bytes with bounded JSON and never follows member URLs', async () => {
    const data = Buffer.alloc(1024 * 1024).toString('base64');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ data, content_type: 'image/png' }));
    const harmony = client(fetchImpl);
    await expect(harmony.nativeAvatar('channel', 'user')).resolves.toEqual({ data, content_type: 'image/png' });
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/channels/channel/bridge-members/user/avatar');
    for (const body of [{ data: '!!!!', content_type: 'image/png' }, { data: 'aW1hZ2U=', content_type: 'image/svg+xml' }, { data: '', content_type: 'image/png' }]) {
      fetchImpl.mockResolvedValueOnce(Response.json(body));
      await expect(harmony.nativeAvatar('channel', 'user')).rejects.toThrow();
    }
  });

  it('identifies with op 2, accepts messages before READY and heartbeats with op 1', async () => {
    const { server, url } = await gateway();
    const harmony = client(undefined, url);
    const received = vi.fn();
    harmony.on('message', received);
    const ready = once(harmony, 'ready');
    const connection = once(server, 'connection');
    harmony.start(); harmony.start();
    const [socket] = await connection;
    const [identify] = await once(socket, 'message');
    expect(JSON.parse(identify.toString())).toEqual({ op: 2, d: { token: 'SECRET' } });
    socket.send(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', d: message }));
    socket.send(JSON.stringify({ op: 0, t: 'MESSAGE_UPDATE', d: message }));
    socket.send(JSON.stringify({ op: 0, t: 'READY', d: { heartbeat_interval: 20 } }));
    await ready;
    expect(received).toHaveBeenCalledExactlyOnceWith({ ...message, encrypted: false });
    const [heartbeat] = await once(socket, 'message');
    expect(JSON.parse(heartbeat.toString())).toEqual({ op: 1 });
    socket.send(JSON.stringify({ op: 11 }));
    harmony.stop();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(server.clients.size).toBe(0);
  });

  it('publishes full Matrix member snapshots across channels, empty updates and READY refreshes', async () => {
    const { server, url } = await gateway();
    const harmony = client(undefined, url);
    const frames: any[] = [];
    const connected = once(server, 'connection');
    const member = { id: '@sam:test', username: 'sam', displayName: 'Sam', avatarUrl: null, source: 'matrix' as const };
    let refreshes = 0;
    harmony.on('ready', () => { refreshes++; harmony.publishMatrixMembers('channel-a', [member]); });
    harmony.start();
    const [socket] = await connected;
    await once(socket, 'message'); // Identify precedes snapshots.
    socket.on('message', (raw: Buffer) => { const frame = JSON.parse(raw.toString()); if (frame.op === 6) frames.push(frame.d); });
    socket.send(JSON.stringify({ op: 0, t: 'READY', d: { heartbeat_interval: 10_000 } }));
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    harmony.publishMatrixMembers('channel-b', [member]);
    harmony.publishMatrixMembers('channel-a', []);
    await vi.waitFor(() => expect(frames).toHaveLength(3));
    expect(frames[2]).toEqual({ platform: 'matrix', channels: [{ harmonyChannelId: 'channel-a', members: [] }, { harmonyChannelId: 'channel-b', members: [member] }] });
    socket.send(JSON.stringify({ op: 0, t: 'READY', d: { heartbeat_interval: 10_000 } }));
    await vi.waitFor(() => expect(frames).toHaveLength(4));
    expect(refreshes).toBe(2);
    expect(frames[3].channels).toEqual([{ harmonyChannelId: 'channel-a', members: [member] }, { harmonyChannelId: 'channel-b', members: [member] }]);
  });

  it('reconnects after disconnect but never loops on revoked tokens', async () => {
    const { server, url } = await gateway();
    const harmony = client(undefined, url);
    const errors = vi.fn();
    harmony.on('error', errors);
    const connections = vi.fn();
    server.on('connection', connections);
    let connected = once(server, 'connection');
    harmony.start();
    let [socket] = await connected;
    await once(socket, 'message');
    connected = once(server, 'connection');
    socket.close(1000);
    [socket] = await connected;
    await once(socket, 'message');
    socket.close(4004, 'Token revoked SECRET');
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(connections).toHaveBeenCalledTimes(2);
    expect(errors.mock.calls.map(([e]) => e.message).join()).not.toContain('SECRET');
    expect(errors).toHaveBeenCalled();
  });

  it('reconnects when heartbeats are not acknowledged', async () => {
    const { server, url } = await gateway();
    const harmony = client(undefined, url);
    let connected = once(server, 'connection');
    harmony.start();
    const [socket] = await connected;
    await once(socket, 'message');
    connected = once(server, 'connection');
    socket.send(JSON.stringify({ op: 0, t: 'READY', d: { heartbeat_interval: 10 } }));
    await connected;
    harmony.stop();
  });

  it('reads member lists of up to 10,000, and one member alone', async () => {
    const members = Array.from({ length: 10_000 }, (_, index) => ({ id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`, username: `user${index}`,
      display_name: 'x'.repeat(60), avatar_url: `https://storage.test/${'a'.repeat(80)}`, domain: 'harmony.test' }));
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(members));
    const harmony = client(fetchImpl);
    await expect(harmony.bridgeMembers('channel')).resolves.toHaveLength(10_000);
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://harmony.example/bot-gateway/api/v1/channels/channel/bridge-members');
    await harmony.bridgeMembers('channel', members[0].id);
    expect(String(fetchImpl.mock.calls[1][0])).toBe(`https://harmony.example/bot-gateway/api/v1/channels/channel/bridge-members?user_id=${members[0].id}`);
    fetchImpl.mockResolvedValueOnce(Response.json([...members, { ...members[0], id: '22222222-2222-4222-8222-222222222222' }]));
    await expect(harmony.bridgeMembers('channel')).rejects.toThrow('oversized');
  }, 20_000);

  it('binds with the alias it was given and surfaces the refusal codes', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ room_id: '!room:test', sender_mode: 'ghost' }));
    const harmony = client(fetchImpl);
    await harmony.bridgeRoom('channel', { room_id: '!room:test', initial_sender_mode: 'ghost', room_alias: '#room:test' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toEqual({ room_id: '!room:test', initial_sender_mode: 'ghost', room_alias: '#room:test' });
    for (const code of ['room_in_use', 'room_changed']) {
      fetchImpl.mockResolvedValueOnce(Response.json({ code, error: 'SECRET' }, { status: 409 }));
      await expect(harmony.bridgeRoom('channel', { room_id: '!room:test', initial_sender_mode: 'ghost' })).rejects.toMatchObject({ errcode: code, transient: false });
    }
  });

  it('surfaces an opted-out author on a send', async () => {
    const harmony = client(vi.fn<typeof fetch>(async () => Response.json({ error: 'SECRET', code: 'BRIDGE_AUTHOR_OPTED_OUT' }, { status: 403 })));
    await expect(harmony.sendMessage('channel', 'hello', {})).rejects.toMatchObject({ status: 403, errcode: 'BRIDGE_AUTHOR_OPTED_OUT', transient: false });
  });

  it('tells of configuration changes and of refused credentials', async () => {
    const { server, url } = await gateway();
    const harmony = client(undefined, url);
    const config = vi.fn();
    const refused = vi.fn();
    harmony.on('config', config).on('refused', refused).on('error', () => {});
    const connected = once(server, 'connection');
    expect(harmony.isRunning).toBe(false);
    harmony.start();
    const [socket] = await connected;
    await once(socket, 'message');
    socket.send(JSON.stringify({ op: 0, t: 'BRIDGE_CONFIG_UPDATE', d: { bridge_id: 'b' } }));
    await vi.waitFor(() => expect(config).toHaveBeenCalledExactlyOnceWith({ bridge_id: 'b' }));
    expect(harmony.isRunning).toBe(true);
    socket.close(4004, 'Invalid or expired token');
    await vi.waitFor(() => expect(refused).toHaveBeenCalledOnce());
    expect(harmony.isRunning).toBe(false);
  });

  it('sends member lists that changed, all of them again after READY, and none of a forgotten channel', async () => {
    const { server, url } = await gateway();
    const harmony = client(undefined, url);
    const frames: any[] = [];
    const connected = once(server, 'connection');
    const member = { id: '@sam:test', username: 'sam', displayName: 'Sam', avatarUrl: null, source: 'matrix' as const };
    const ready = once(harmony, 'ready');
    harmony.start();
    const [socket] = await connected;
    await once(socket, 'message');
    socket.on('message', (raw: Buffer) => { const frame = JSON.parse(raw.toString()); if (frame.op === 6) frames.push(frame.d.channels.map((channel: any) => channel.harmonyChannelId)); });
    socket.send(JSON.stringify({ op: 0, t: 'READY', d: { heartbeat_interval: 10_000 } }));
    await ready;
    harmony.publishMatrixMembers('a', [member]);
    harmony.publishMatrixMembers('a', [{ ...member }]);
    harmony.publishMatrixMembers('b', []);
    await vi.waitFor(() => expect(frames).toEqual([['a'], ['a', 'b']]));
    const again = once(harmony, 'ready');
    socket.send(JSON.stringify({ op: 0, t: 'READY', d: { heartbeat_interval: 10_000 } }));
    await again;
    harmony.publishMatrixMembers('a', [member]);
    harmony.forgetMatrixMembers('a');
    harmony.forgetMatrixMembers('a');
    await vi.waitFor(() => expect(frames.slice(2)).toEqual([['a', 'b'], ['b']]));
  });

  it('gathers member lists that change together into one frame', async () => {
    const { server, url } = await gateway();
    const harmony = new HarmonyClient({ apiUrl: 'https://harmony.example', gatewayUrl: url, token: 'SECRET', memberFrameMs: 100 });
    cleanups.push(() => harmony.stop());
    const frames: any[] = [];
    const connected = once(server, 'connection');
    const ready = once(harmony, 'ready');
    harmony.start();
    const [socket] = await connected;
    await once(socket, 'message');
    socket.on('message', (raw: Buffer) => { const frame = JSON.parse(raw.toString()); if (frame.op === 6) frames.push(frame.d.channels.length); });
    socket.send(JSON.stringify({ op: 0, t: 'READY', d: { heartbeat_interval: 10_000 } }));
    await ready;
    for (let index = 0; index < 20; index++) harmony.publishMatrixMembers(`channel-${index}`, []);
    await vi.waitFor(() => expect(frames).toEqual([1, 20]));
  });

  const checkAnswer = (extra: Record<string, unknown> = {}) => ({ platform: 'matrix', room_id: '!room:test', sender_mode: 'ghost', messages_encrypted: false, relay_allowed: null, member: null, ...extra });
  const userId = '11111111-1111-4111-8111-111111111111';
  const member = { id: userId, username: 'alice', display_name: 'Alice', avatar_url: 'https://storage.test/a.png', domain: 'harmony.test', is_local: true };

  it('reads everything a relay depends on in one request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(checkAnswer()));
    const harmony = client(fetchImpl);
    await expect(harmony.check('channel/a')).resolves.toEqual({ registered: true, roomId: '!room:test', mode: 'ghost', plaintext: true, relayAllowed: false, member: null });
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://harmony.example/bot-gateway/api/v1/channels/channel%2Fa/bridge-check');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { Authorization: 'Bot SECRET' }, redirect: 'error' });
    fetchImpl.mockImplementation(async () => Response.json(checkAnswer({ relay_allowed: true, member })));
    await expect(harmony.check('channel', userId)).resolves.toMatchObject({ relayAllowed: true, member: { id: userId, display_name: 'Alice' } });
    expect(String(fetchImpl.mock.calls[1][0])).toBe(`https://harmony.example/bot-gateway/api/v1/channels/channel/bridge-check?user_id=${userId}`);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('takes a channel without an active binding as unregistered, and anything it does not understand as no answer', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ platform: null, room_id: null, sender_mode: null, messages_encrypted: null, relay_allowed: null, member: null }));
    const harmony = client(fetchImpl);
    await expect(harmony.check('channel', userId)).resolves.toEqual({ registered: false, roomId: null, mode: null, plaintext: false, relayAllowed: false, member: null });
    for (const broken of [{ platform: 'discord' }, { platform: undefined }, { messages_encrypted: null }, { messages_encrypted: 'false' }, { sender_mode: 'else' }, { room_id: 'room' }, { room_id: undefined },
      { relay_allowed: null }, { relay_allowed: 'true' }, { relay_allowed: true, member: { ...member, id: '22222222-2222-4222-8222-222222222222' } }, { relay_allowed: true, member: 'x' }]) {
      fetchImpl.mockImplementationOnce(async () => Response.json(checkAnswer({ relay_allowed: true, ...broken })));
      await expect(harmony.check('channel', userId), JSON.stringify(broken)).rejects.toThrow('Invalid bridge');
    }
    fetchImpl.mockImplementationOnce(async () => Response.json(checkAnswer({ messages_encrypted: true, relay_allowed: false, room_id: null })));
    await expect(harmony.check('channel', userId)).resolves.toMatchObject({ plaintext: false, relayAllowed: false, roomId: null });
    for (const status of [400, 403, 503]) {
      fetchImpl.mockImplementationOnce(async () => Response.json({}, { status }));
      await expect(harmony.check('channel')).rejects.toMatchObject({ status });
    }
    fetchImpl.mockClear();
    await harmony.check('channel').catch(() => {});
    expect(String(fetchImpl.mock.calls[0][0])).toContain('bridge-check');
  });

  it('falls back to the separate routes of 1.9.8, remembers it and asks the route again after a READY that has it', async () => {
    const { server, url } = await gateway();
    const answers: Record<string, unknown> = { 'bridge-platform': { platform: 'matrix' }, encryption: { messages_encrypted: false }, 'bridge-room': { room_id: '!room:test', sender_mode: 'ghost' },
      [`bridge-consent/${userId}`]: { relay_allowed: true }, 'bridge-members': [member] };
    let has = false;
    const paths: string[] = [];
    const harmony = client(vi.fn<typeof fetch>(async input => {
      const path = new URL(String(input)).pathname.split('/channels/channel/')[1];
      paths.push(path);
      if (path === 'bridge-check') return has ? Response.json(checkAnswer({ relay_allowed: true, member })) : new Response('Cannot GET', { status: 404 });
      return Response.json(answers[path]);
    }), url);
    const expected = { registered: true, roomId: '!room:test', mode: 'ghost', plaintext: true, relayAllowed: true, member: { id: userId, username: 'alice', display_name: 'Alice', avatar_url: 'https://storage.test/a.png', domain: 'harmony.test' } };
    await expect(harmony.check('channel', userId)).resolves.toEqual(expected);
    expect(paths).toEqual(['bridge-check', 'bridge-platform', 'encryption', 'bridge-room', `bridge-consent/${userId}`, 'bridge-members']);
    paths.length = 0;
    await harmony.check('channel');
    expect(paths).toEqual(['bridge-platform', 'encryption', 'bridge-room']);
    answers[`bridge-consent/${userId}`] = { relay_allowed: false };
    await expect(harmony.check('channel', userId)).resolves.toMatchObject({ relayAllowed: false, member: null });
    answers['bridge-platform'] = { platform: null };
    await expect(harmony.check('channel', userId)).rejects.toThrow('not registered');

    const connected = once(server, 'connection');
    const ready = once(harmony, 'ready');
    harmony.start();
    const [socket] = await connected;
    await once(socket, 'message');
    socket.send(JSON.stringify({ op: 0, t: 'READY', d: { heartbeat_interval: 10_000, capabilities: ['matrix_bridge_v2', 'matrix_bridge_check'] } }));
    await ready;
    has = true;
    paths.length = 0;
    await expect(harmony.check('channel', userId)).resolves.toEqual(expected);
    expect(paths).toEqual(['bridge-check']);
    const again = once(harmony, 'ready');
    socket.send(JSON.stringify({ op: 0, t: 'READY', d: { heartbeat_interval: 10_000, capabilities: ['matrix_bridge_v2'] } }));
    await again;
    answers['bridge-platform'] = { platform: 'matrix' };
    paths.length = 0;
    await harmony.check('channel');
    expect(paths).toEqual(['bridge-platform', 'encryption', 'bridge-room']);
  });

  it('reads an unbound pair\'s room as none, and no answer to a binding as that', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ room_id: null, sender_mode: 'ghost' }));
    const harmony = client(fetchImpl);
    await expect(harmony.bridgeRoom('channel')).resolves.toEqual({ room_id: null, sender_mode: 'ghost' });
    await expect(harmony.bridgeRoom('channel', { room_id: '!room:test', initial_sender_mode: 'ghost' })).rejects.toThrow('Invalid Matrix room binding');
  });

  it('tells who joined or left the server', async () => {
    const { server, url } = await gateway();
    const harmony = client(undefined, url);
    const changed = vi.fn();
    harmony.on('member', changed);
    const connected = once(server, 'connection');
    harmony.start();
    const [socket] = await connected;
    await once(socket, 'message');
    for (const [t, user] of [['SERVER_MEMBER_ADD', { id: userId }], ['SERVER_MEMBER_REMOVE', { id: userId }], ['SERVER_MEMBER_ADD', { id: 'x' }], ['SERVER_MEMBER_REMOVE', null], ['SERVER_MEMBER_KICK', { id: userId }]]) {
      socket.send(JSON.stringify({ op: 0, t, d: { server_id: 's', user } }));
    }
    socket.send(JSON.stringify({ op: 0, t: 'BRIDGE_CONFIG_UPDATE', d: {} }));
    await once(harmony, 'config');
    expect(changed.mock.calls).toEqual([[userId], [userId]]);
  });
});
