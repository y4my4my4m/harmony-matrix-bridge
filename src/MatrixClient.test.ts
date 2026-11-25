import { describe, expect, it, vi } from 'vitest';
import { ResponseTooLarge } from './http.js';
import { MatrixClient } from './MatrixClient.js';

function setup() {
  const fetchImpl = vi.fn<typeof fetch>();
  const client = new MatrixClient({ homeserverUrl: 'https://matrix.example/proxy', asToken: 'SECRET', botUserId: '@relay:matrix.example', fetchImpl });
  return { fetchImpl, client };
}

describe('MatrixClient', () => {
  it('sends idempotent plaintext transactions as the AS bot', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(Response.json({ event_id: '$event' }));
    await expect(client.sendMessage('!room:example', 'txn/a', 'hello')).resolves.toEqual({ event_id: '$event' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://matrix.example/proxy/_matrix/client/v3/rooms/!room%3Aexample/send/m.room.message/txn%2Fa?user_id=%40relay%3Amatrix.example');
    expect(init).toMatchObject({ method: 'PUT', headers: { Authorization: 'Bearer SECRET' }, redirect: 'error' });
    expect(JSON.parse(init!.body as string)).toEqual({ msgtype: 'm.text', body: 'hello', 'm.mentions': {} });
  });

  it('only treats an explicit M_NOT_FOUND 404 as plaintext', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 }));
    await expect(client.roomIsPlaintext('!room:example')).resolves.toBe(true);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/state/m.room.encryption/?');
    fetchImpl.mockResolvedValueOnce(Response.json({ algorithm: 'm.megolm.v1.aes-sha2' }));
    await expect(client.roomIsPlaintext('!room:example')).resolves.toBe(false);
    for (const [status, body] of [[404, {}], [403, { errcode: 'M_FORBIDDEN' }], [500, { errcode: 'M_NOT_FOUND' }]] as const) {
      fetchImpl.mockResolvedValueOnce(Response.json(body, { status }));
      await expect(client.roomIsPlaintext('!room:example')).rejects.toThrow();
    }
  });

  it('reads room-specific member state with AS auth, not global profiles', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(Response.json({ membership: 'join', displayname: 'Room Alice', avatar_url: 'mxc://media.test/image' }));
    await expect(client.roomMember('!room:example', '@alice:example')).resolves.toEqual({ display_name: 'Room Alice', avatar_mxc: 'mxc://media.test/image' });
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/rooms/!room%3Aexample/state/m.room.member/%40alice%3Aexample?user_id=');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer SECRET' }, redirect: 'error' });
  });

  it.each(['', 'x'.repeat(101), 'bad\nname', null, {}, 42])('omits invalid member display names (%s)', async displayname => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(Response.json({ membership: 'join', displayname }));
    await expect(client.roomMember('room', '@alice:example')).resolves.toEqual({});
  });

  it.each(['https://external.test/a.png', 'mxc://host/../../secret', 'mxc://user:pass@host/a', 'mxc://host/a?token=x', 'mxc://../a', 'mxc://host/a#x', 'mxc://host/' + 'x'.repeat(2048), {}])('omits invalid or external avatar %s', async avatar_url => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(Response.json({ membership: 'join', avatar_url }));
    await expect(client.roomMember('room', '@alice:example')).resolves.toEqual({});
    if (typeof avatar_url === 'string') await expect(client.avatarThumbnail(avatar_url)).rejects.toThrow('Invalid Matrix avatar URI');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('fails closed on missing/left member state and fetch failures', async () => {
    const { client, fetchImpl } = setup();
    for (const body of [{}, { membership: 'leave' }, { membership: 'invite' }]) {
      fetchImpl.mockResolvedValueOnce(Response.json(body));
      await expect(client.roomMember('room', '@alice:example')).rejects.toThrow();
    }
    fetchImpl.mockResolvedValueOnce(Response.json({}, { status: 503 }));
    await expect(client.roomMember('room', '@alice:example')).rejects.toThrow();
  });

  it('fetches authenticated thumbnails only from the configured HS, never the MXC host', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(new Response('image bytes', { headers: { 'Content-Type': 'image/png' } }));
    await expect(client.avatarThumbnail('mxc://remote.test:8448/image')).resolves.toEqual({ data: Buffer.from('image bytes').toString('base64'), content_type: 'image/png' });
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://matrix.example/proxy/_matrix/client/v1/media/thumbnail/remote.test%3A8448/image?width=128&height=128&method=scale');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer SECRET' }, redirect: 'error', signal: expect.any(AbortSignal) });
  });

  it.each([
    new Response('svg', { headers: { 'Content-Type': 'image/svg+xml' } }),
    new Response('', { headers: { 'Content-Type': 'image/png' } }),
    new Response('large', { headers: { 'Content-Type': 'image/png', 'Content-Length': '1048577' } }),
    new Response(new Uint8Array(1048577), { headers: { 'Content-Type': 'image/jpeg' } }),
    new Response(null, { status: 302, headers: { Location: 'https://evil.test' } }),
    new Response(null, { status: 204 }),
  ])('rejects unsafe thumbnail responses %#', async response => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(response);
    await expect(client.avatarThumbnail('mxc://media.test/image')).rejects.toThrow();
  });

  it('joins rooms as the bot', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(Response.json({ room_id: '!room:example' }));
    await client.joinRoom('!room:example');
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/join/!room%3Aexample?user_id=');
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('POST');
  });

  it('registers the bot localpart without impersonation query', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(Response.json({ user_id: '@relay:matrix.example' }));
    await client.ensureRegistered();
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://matrix.example/proxy/_matrix/client/v3/register');
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toEqual({ type: 'm.login.application_service', username: 'relay' });
    fetchImpl.mockResolvedValueOnce(Response.json({ errcode: 'M_USER_IN_USE' }, { status: 400 }));
    await expect(client.ensureRegistered()).resolves.toBeUndefined();
    fetchImpl.mockResolvedValueOnce(Response.json({ errcode: 'M_FORBIDDEN' }, { status: 403 }));
    await expect(client.ensureRegistered()).rejects.toThrow();
  });

  it('registers a dedicated ghost, proves AS ownership, and refuses unknown collisions', async () => {
    const { client, fetchImpl } = setup();
    const ghost = '@relay_h_11111111111141118111111111111111:matrix.example';
    fetchImpl.mockResolvedValueOnce(Response.json({ user_id: ghost })).mockResolvedValueOnce(Response.json({ user_id: ghost }));
    await client.registerGhost(ghost, false);
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string).username).toBe(ghost.slice(1, ghost.indexOf(':')));
    expect(String(fetchImpl.mock.calls[1][0])).toContain('/account/whoami?user_id=');
    fetchImpl.mockResolvedValueOnce(Response.json({ errcode: 'M_USER_IN_USE' }, { status: 400 }));
    await expect(client.registerGhost(ghost, false)).rejects.toThrow();
    fetchImpl.mockResolvedValueOnce(Response.json({ errcode: 'M_USER_IN_USE' }, { status: 400 })).mockResolvedValueOnce(Response.json({ user_id: ghost }));
    await expect(client.registerGhost(ghost, true)).resolves.toBeUndefined();
    await expect(client.registerGhost('@outsider:matrix.example', true)).rejects.toThrow('outside dedicated ghost namespace');
  });

  it('takes over a ghost it does not know where that is allowed, once the homeserver owns that it is the service\'s', async () => {
    const ghost = '@relay_h_11111111111141118111111111111111:matrix.example';
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new MatrixClient({ homeserverUrl: 'https://matrix.example', asToken: 'SECRET', botUserId: '@relay:matrix.example', adoptsGhosts: true, fetchImpl });
    const inUse = () => Response.json({ errcode: 'M_USER_IN_USE' }, { status: 400 });
    fetchImpl.mockResolvedValueOnce(inUse()).mockResolvedValueOnce(Response.json({ user_id: ghost }));
    await expect(client.registerGhost(ghost, false)).resolves.toBeUndefined();
    expect(String(fetchImpl.mock.calls[1][0])).toContain(`/account/whoami?user_id=${encodeURIComponent(ghost)}`);
    for (const who of [Response.json({ user_id: '@relay:matrix.example' }), Response.json({ errcode: 'M_FORBIDDEN' }, { status: 403 }), Response.json({})]) {
      fetchImpl.mockResolvedValueOnce(inUse()).mockResolvedValueOnce(who);
      await expect(client.registerGhost(ghost, false)).rejects.toMatchObject({ transient: false });
    }
    fetchImpl.mockResolvedValueOnce(Response.json({ errcode: 'M_EXCLUSIVE' }, { status: 400 }));
    await expect(client.registerGhost(ghost, false)).rejects.toMatchObject({ errcode: 'M_EXCLUSIVE' });
    fetchImpl.mockClear();
    for (const other of ['@alice:matrix.example', '@relay_h_1111:matrix.example', '@relay_h_11111111111141118111111111111111:elsewhere.example', '@relay_h_alice:matrix.example']) {
      await expect(client.registerGhost(other, false)).rejects.toThrow('outside dedicated ghost namespace');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('knows who may change a room', async () => {
    const { client, fetchImpl } = setup();
    const alice = '@alice:example';
    const may = async (create: unknown, levels: unknown) => {
      fetchImpl.mockImplementation(async input => {
        const path = String(input);
        if (path.includes('/state/m.room.create')) { expect(path).toContain('format=event'); return Response.json(create); }
        return levels === null ? Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 }) : Response.json(levels);
      });
      return client.mayChangeRoom('!room:example', alice);
    };
    const made = (room_version: string, sender = '@owner:example', extra = {}) => ({ type: 'm.room.create', sender, content: { room_version, ...extra } });
    for (const [levels, allowed] of [
      [{ users: { [alice]: 100 } }, true], [{ users: { [alice]: 50 } }, true], [{ users: { [alice]: 49 } }, false], [{}, false], [{ users: { '@bob:example': 100 } }, false],
      [{ users_default: 50 }, true], [{ users: { [alice]: 0 }, users_default: 100 }, false], [{ users: { [alice]: 50 }, state_default: 75 }, false], [{ users: { [alice]: 0 }, state_default: 0 }, true],
      [{ users: { [alice]: 50 }, events: { 'm.room.power_levels': 100 } }, false], [{ users: { [alice]: 100 }, events: { 'm.room.power_levels': 100 } }, true],
      [{ users: { [alice]: 60 }, state_default: 75, events: { 'm.room.power_levels': 0 } }, false], [{ users: { [alice]: '100' } }, true],
      [{ users: { [alice]: 'all' } }, false], [{ users: { [alice]: null } }, false], [{ users: { [alice]: 50 }, state_default: 'none' }, false], [{ users: { [alice]: 100 }, state_default: null }, false],
      [{ users: { [alice]: 100 }, events: { 'm.room.power_levels': 'x' } }, false], [{ users: [alice] }, false], [{ users: { [alice]: 1e400 } }, false],
    ] as Array<[unknown, boolean]>) expect(await may(made('11'), levels), JSON.stringify(levels)).toBe(allowed);
    // A creator has no more power than the levels say, before room version 12.
    expect(await may(made('11', alice), { users: { [alice]: 0 } })).toBe(false);
    expect(await may(made('11', alice), null)).toBe(true);
    expect(await may(made('11'), null)).toBe(false);
    expect(await may(made('12', alice), { users: {} })).toBe(true);
    expect(await may(made('12', '@owner:example', { additional_creators: [alice] }), { state_default: 100 })).toBe(true);
    expect(await may(made('12'), { users: { [alice]: 10 } })).toBe(false);
    expect(await may(made('11', '@owner:example', { additional_creators: [alice] }), { users: {} })).toBe(false);
    fetchImpl.mockImplementation(async () => Response.json({ errcode: 'M_FORBIDDEN' }, { status: 403 }));
    await expect(client.mayChangeRoom('!room:example', alice)).rejects.toThrow();
  });

  it('leaves a room, with a reason where there is one', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockImplementation(async () => Response.json({}));
    await client.leaveRoom('!room:example', 'why');
    await client.leaveRoom('!room:example');
    expect(fetchImpl.mock.calls.map(call => [String(call[0]).includes('/rooms/!room%3Aexample/leave?user_id=%40relay'), call[1]!.body])).toEqual([[true, '{"reason":"why"}'], [true, '{}']]);
  });

  it('invites and joins ghosts with room-specific profiles, not global profiles', async () => {
    const { client, fetchImpl } = setup();
    const ghost = '@relay_h_11111111111141118111111111111111:matrix.example';
    fetchImpl.mockResolvedValueOnce(Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ errcode: 'M_FORBIDDEN' }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(Response.json({}));
    await client.joinGhost('!room:example', ghost, { displayname: 'Room Nick', avatar_url: 'mxc://matrix.example/a' });
    expect(String(fetchImpl.mock.calls[1][0])).toContain(`/join/!room%3Aexample?user_id=${encodeURIComponent(ghost)}`);
    expect(String(fetchImpl.mock.calls[2][0])).toContain('/invite?user_id=%40relay%3A');
    expect(JSON.parse(fetchImpl.mock.calls[2][1]!.body as string)).toEqual({ user_id: ghost });
    expect(String(fetchImpl.mock.calls[3][0])).toContain(`/join/!room%3Aexample?user_id=${encodeURIComponent(ghost)}`);
    expect(JSON.parse(fetchImpl.mock.calls[4][1]!.body as string)).toEqual({ membership: 'join', displayname: 'Room Nick', avatar_url: 'mxc://matrix.example/a' });
    fetchImpl.mockResolvedValueOnce(Response.json({ event_id: '$ghost-event' }));
    await client.sendMessage('!room:example', 'txn', 'Hi Sam', { sender: ghost, userIds: ['@sam:example'], formattedBody: 'Hi <a href="https://matrix.to/#/%40sam%3Aexample">Sam</a>' });
    expect(String(fetchImpl.mock.calls[5][0])).toContain(`user_id=${encodeURIComponent(ghost)}`);
    expect(JSON.parse(fetchImpl.mock.calls[5][1]!.body as string)).toMatchObject({ 'm.mentions': { user_ids: ['@sam:example'] }, format: 'org.matrix.custom.html' });
  });

  it('joins a ghost to a public room without an invite, and invites for no other refusal than a forbidden join', async () => {
    const { client, fetchImpl } = setup();
    const ghost = '@relay_h_11111111111141118111111111111111:matrix.example';
    const paths = () => fetchImpl.mock.calls.map(call => new URL(String(call[0])).pathname.replace(/.*\/v3\//, ''));
    fetchImpl.mockResolvedValueOnce(Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 })).mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(Response.json({}));
    await client.joinGhost('!room:example', ghost, { displayname: 'Nick' });
    expect(paths().filter(path => path.includes('invite'))).toEqual([]);
    expect(paths()[1]).toBe('join/!room%3Aexample');
    for (const [status, errcode] of [[429, 'M_LIMIT_EXCEEDED'], [404, 'M_NOT_FOUND'], [502, 'M_UNKNOWN']] as const) {
      fetchImpl.mockClear();
      fetchImpl.mockResolvedValueOnce(Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 })).mockResolvedValueOnce(Response.json({ errcode }, { status }));
      await expect(client.joinGhost('!room:example', ghost, { displayname: 'Nick' })).rejects.toMatchObject({ status });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
    fetchImpl.mockClear();
    fetchImpl.mockResolvedValueOnce(Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ errcode: 'M_FORBIDDEN' }, { status: 403 })).mockResolvedValueOnce(Response.json({ errcode: 'M_FORBIDDEN' }, { status: 403 }));
    await expect(client.joinGhost('!room:example', ghost, { displayname: 'Nick' })).rejects.toMatchObject({ status: 403 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('preserves the room avatar when refresh bytes are unavailable, but clears an explicit removal', async () => {
    const { client, fetchImpl } = setup();
    const ghost = '@relay_h_11111111111141118111111111111111:matrix.example';
    fetchImpl.mockResolvedValueOnce(Response.json({ membership: 'join', displayname: 'Old Nick', avatar_url: 'mxc://matrix.example/old' }))
      .mockResolvedValueOnce(Response.json({}));
    await client.joinGhost('!room:example', ghost, { displayname: 'New Nick' });
    expect(JSON.parse(fetchImpl.mock.calls[1][1]!.body as string)).toEqual({ membership: 'join', displayname: 'New Nick', avatar_url: 'mxc://matrix.example/old' });
    fetchImpl.mockResolvedValueOnce(Response.json({ membership: 'join', displayname: 'New Nick', avatar_url: 'mxc://matrix.example/old' }))
      .mockResolvedValueOnce(Response.json({}));
    await client.joinGhost('!room:example', ghost, { displayname: 'New Nick', avatar_url: '' });
    expect(JSON.parse(fetchImpl.mock.calls[3][1]!.body as string).avatar_url).toBe('');
  });

  it('uploads only supplied native avatar bytes to the configured HS', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(Response.json({ content_uri: 'mxc://matrix.example/native' }));
    await expect(client.uploadAvatar({ data: 'aW1hZ2U=', content_type: 'image/png' })).resolves.toBe('mxc://matrix.example/native');
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://matrix.example/proxy/_matrix/media/v3/upload');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer SECRET', 'Content-Type': 'image/png' }, redirect: 'error' });
  });

  it('downloads full authenticated media only through the configured homeserver', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(new Response('file bytes', { headers: { 'Content-Type': 'application/pdf' } }));
    await expect(client.downloadFile('mxc://remote.test:8448/document', 'report.pdf'))
      .resolves.toEqual({ bytes: Buffer.from('file bytes'), name: 'report.pdf', contentType: 'application/pdf' });
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://matrix.example/proxy/_matrix/client/v1/media/download/remote.test%3A8448/document');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer SECRET' }, redirect: 'error' });
  });

  it.each(['https://evil.test/file?token=SECRET', 'mxc://host/../../secret', 'mxc://user:SECRET@host/file', 'mxc://host/file?token=SECRET', 'mxc://../file'])('rejects invalid attachment URI without fetching %s', async uri => {
    const { client, fetchImpl } = setup();
    await expect(client.downloadFile(uri, 'file')).rejects.toThrow('Invalid Matrix media URI');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uploads binary media and safe Unicode names, not source URLs or JSON', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(Response.json({ content_uri: 'mxc://matrix.example/file' }));
    await expect(client.uploadFile({ bytes: Buffer.from('binary'), name: '../写真.pdf', contentType: 'Application/PDF; charset=binary' })).resolves.toBe('mxc://matrix.example/file');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(new URL(String(url)).searchParams.get('filename')).toBe('.._写真.pdf');
    expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer SECRET', 'Content-Type': 'application/pdf' }, body: Buffer.from('binary'), redirect: 'error' });
    fetchImpl.mockResolvedValueOnce(Response.json({ content_uri: 'https://evil.test/SECRET' }));
    await expect(client.uploadFile({ bytes: Buffer.alloc(0), name: 'empty.txt', contentType: 'text/plain' })).rejects.toThrow('Invalid Matrix media upload response');
  });

  it.each([['image/png', 'm.image'], ['image/apng', 'm.image'], ['image/avif', 'm.image'], ['application/pdf', 'm.file'], ['audio/ogg', 'm.file'], ['video/mp4', 'm.file']])('sends %s as %s with an idempotent ghost transaction', async (contentType, msgtype) => {
    const { client, fetchImpl } = setup();
    const sender = '@relay_h_11111111111141118111111111111111:matrix.example';
    fetchImpl.mockResolvedValue(Response.json({ event_id: '$file-event' }));
    await expect(client.sendFile('!room:example', 'source/file/2', { mxc: 'mxc://matrix.example/file', name: 'image.png', contentType, size: 123 },
      { sender, userIds: ['@sam:example'], formattedBody: '<b>not a caption</b>' })).resolves.toEqual({ event_id: '$file-event' });
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/source%2Ffile%2F2?user_id=' + encodeURIComponent(sender));
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toEqual({ msgtype, body: 'image.png', filename: 'image.png',
      url: 'mxc://matrix.example/file', info: { size: 123, mimetype: contentType }, 'm.mentions': {} });
  });

  it('refuses attachment sender spoofing and malformed send responses', async () => {
    const { client, fetchImpl } = setup();
    const file = { mxc: 'mxc://matrix.example/file', name: 'file', contentType: 'application/pdf', size: 0 };
    await expect(client.sendFile('room', 'txn', file, { sender: '@outsider:matrix.example' })).rejects.toThrow('outside dedicated ghost namespace');
    await expect(client.sendFile('room', 'txn', { ...file, mxc: 'https://evil.test/SECRET' })).rejects.toThrow('Invalid Matrix file');
    await expect(client.sendFile('room', 'txn', { ...file, size: 52428801 })).rejects.toThrow('Invalid Matrix file');
    expect(fetchImpl).not.toHaveBeenCalled();
    fetchImpl.mockResolvedValue(Response.json({}));
    await expect(client.sendFile('room', 'txn', file)).rejects.toThrow('Invalid Matrix message response');
  });

  it('rejects malformed send results', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(Response.json({}));
    await expect(client.sendMessage('room', 'txn', 'body')).rejects.toThrow('Invalid Matrix message response');
  });

  function account(fetchImpl = vi.fn<typeof fetch>()) {
    return { fetchImpl, client: new MatrixClient({ homeserverUrl: 'https://matrix.example', asToken: 'SECRET', botUserId: '@me:example', account: true, fetchImpl }) };
  }
  const missing = () => Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 });

  it('acts as an ordinary account without impersonation, and has no ghosts', async () => {
    const { client, fetchImpl } = account();
    fetchImpl.mockResolvedValueOnce(Response.json({ event_id: '$event' })).mockResolvedValueOnce(Response.json({ user_id: '@me:example' }));
    await client.sendMessage('!room:example', 'txn', 'hello', { sender: '@me:example' });
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://matrix.example/_matrix/client/v3/rooms/!room%3Aexample/send/m.room.message/txn');
    await expect(client.whoami()).resolves.toBe('@me:example');
    for (const ghostly of [() => client.registerGhost('@me_h_11111111111141118111111111111111:example', false),
      () => client.joinGhost('!room', '@me_h_11111111111141118111111111111111:example', { displayname: 'x' }),
      () => client.sendMessage('!room', 'txn', 'x', { sender: '@me_h_11111111111141118111111111111111:example' })]) await expect(ghostly()).rejects.toThrow('no ghosts');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('answers a person with a notice that replies to them', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(Response.json({ event_id: '$event' }));
    await client.sendMessage('!room', 'txn', 'done', { notice: true, userIds: ['@a:example'], replyTo: '$ask' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toEqual({ msgtype: 'm.notice', body: 'done', 'm.mentions': { user_ids: ['@a:example'] }, 'm.relates_to': { 'm.in_reply_to': { event_id: '$ask' } } });
  });

  it('proves it may act as its sender', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(Response.json({ user_id: '@relay:matrix.example' })).mockResolvedValueOnce(Response.json({ user_id: '@else:matrix.example' }))
      .mockResolvedValueOnce(Response.json({ errcode: 'M_UNKNOWN_TOKEN' }, { status: 401 }));
    await client.verifySender();
    await expect(client.verifySender()).rejects.toThrow('cannot own');
    await expect(client.verifySender()).rejects.toMatchObject({ status: 401, errcode: 'M_UNKNOWN_TOKEN' });
  });

  it('resolves an alias and joins through its servers and the room\'s own', async () => {
    const { client, fetchImpl } = account();
    fetchImpl.mockResolvedValueOnce(Response.json({ room_id: '!room:other.test', servers: ['a.test', 42, 'b.test'] })).mockResolvedValueOnce(Response.json({ room_id: '!room:other.test' }));
    const resolved = await client.resolveAlias('#town:other.test');
    expect(resolved).toEqual({ roomId: '!room:other.test', servers: ['a.test', 'b.test'] });
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://matrix.example/_matrix/client/v3/directory/room/%23town%3Aother.test');
    await client.joinRoom(resolved.roomId, resolved.servers);
    const url = new URL(String(fetchImpl.mock.calls[1][0]));
    expect(url.searchParams.getAll('via')).toEqual(['a.test', 'b.test', 'other.test']);
    expect(url.searchParams.getAll('server_name')).toEqual(['a.test', 'b.test', 'other.test']);
    fetchImpl.mockResolvedValueOnce(Response.json({ room_id: 'https://evil.test' }));
    await expect(client.resolveAlias('#town:other.test')).rejects.toThrow('Invalid Matrix room alias');
  });

  it('reads its own membership and takes a refusal as none', async () => {
    const { client, fetchImpl } = account();
    for (const [body, status, expected] of [[{ membership: 'join' }, 200, 'join'], [{ membership: 'ban' }, 200, 'ban'], [{ membership: 'odd' }, 200, null], [{ errcode: 'M_FORBIDDEN' }, 403, null], [{ errcode: 'M_NOT_FOUND' }, 404, null]] as const) {
      fetchImpl.mockResolvedValueOnce(Response.json(body, { status }));
      await expect(client.membership('!room')).resolves.toBe(expected);
    }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/state/m.room.member/%40me%3Aexample');
    fetchImpl.mockResolvedValueOnce(Response.json({}, { status: 503 }));
    await expect(client.membership('!room')).rejects.toThrow();
  });

  it.each([
    [null, undefined, true],
    [{}, undefined, true],
    [{ events_default: 50 }, undefined, false],
    [{ events_default: 50, users: { '@me:example': 50 } }, undefined, true],
    [{ events: { 'm.room.message': 10 }, users_default: 5 }, undefined, false],
    [{ events: { 'm.room.message': 0 }, events_default: 50 }, undefined, true],
    [{ events_default: '50', users: { '@me:example': '50' } }, undefined, true],
    [{ events_default: 50 }, { type: 'm.room.create', sender: '@me:example', content: { room_version: '12' } }, true],
    [{ events_default: 50 }, { sender: '@else:example', content: { room_version: '12', additional_creators: ['@me:example'] } }, true],
    [{ events_default: 50 }, { sender: '@me:example', content: { room_version: '11' } }, false],
  ])('reads from power levels %j and creation %j whether it may send: %s', async (levels, create, expected) => {
    const { client, fetchImpl } = account();
    fetchImpl.mockImplementation(async input => String(input).includes('power_levels') ? (levels ? Response.json(levels) : missing()) : create ? Response.json(create) : missing());
    await expect(client.canSend('!room')).resolves.toBe(expected);
  });

  it('describes a room for the list, bounding its name, and leaves spaces out', async () => {
    const { client, fetchImpl } = account();
    const states: Record<string, unknown> = { 'm.room.name': { name: ` Town\u202e\u0000 ${'x'.repeat(200)}` }, 'm.room.canonical_alias': { alias: 'not an alias' } };
    fetchImpl.mockImplementation(async input => {
      const url = String(input);
      if (url.includes('joined_members')) return Response.json({ joined: { '@a:example': {}, '@b:example': {} } });
      const type = Object.keys(states).find(name => url.includes(`/state/${name}/`));
      return type ? Response.json(states[type]) : missing();
    });
    const info = await client.roomInfo('!room:example');
    expect(info).toMatchObject({ room_id: '!room:example', alias: null, encrypted: false, can_send: true, members: 2 });
    expect(info!.name).toMatch(/^Town x+$/);
    expect(info!.name).toHaveLength(100);
    states['m.room.encryption'] = { algorithm: 'm.megolm.v1.aes-sha2' };
    await expect(client.roomInfo('!room:example')).resolves.toMatchObject({ encrypted: true });
    states['m.room.create'] = { type: 'm.space' };
    await expect(client.roomInfo('!room:example')).resolves.toBeNull();
  });

  it('counts the members of large rooms and does not know those of huge ones', async () => {
    const { client, fetchImpl } = account();
    const members = (count: number) => Response.json({ joined: Object.fromEntries(Array.from({ length: count }, (_, index) => [`@person${index}:example`, { display_name: 'x'.repeat(40) }])) });
    fetchImpl.mockImplementation(async input => String(input).includes('joined_members') ? members(5_000) : missing());
    await expect(client.roomMembers('!room')).resolves.toHaveLength(5_000);
    fetchImpl.mockImplementation(async input => String(input).includes('joined_members') ? members(120_000) : missing());
    await expect(client.roomMembers('!room')).rejects.toBeInstanceOf(ResponseTooLarge);
    await expect(client.roomInfo('!room')).resolves.toMatchObject({ members: null });
  }, 20_000);

  it('knows the account\'s direct chats', async () => {
    const { client, fetchImpl } = account();
    fetchImpl.mockResolvedValueOnce(Response.json({ '@a:example': ['!dm1', 42], '@b:example': 'x' })).mockResolvedValueOnce(missing()).mockResolvedValueOnce(Response.json({ joined_rooms: ['!a', 'bad', '!b'] }));
    await expect(client.directRooms()).resolves.toEqual(new Set(['!dm1']));
    await expect(client.directRooms()).resolves.toEqual(new Set());
    await expect(client.joinedRooms()).resolves.toEqual(['!a', '!b']);
  });

  it('long polls with its own time and size limits, and reads each room\'s events', async () => {
    const { client, fetchImpl } = account();
    const body = 'x'.repeat(2 * 1024 * 1024);
    fetchImpl.mockResolvedValueOnce(Response.json({ filter_id: '7' })).mockResolvedValueOnce(Response.json({ next_batch: 's2', rooms: {
      join: { '!a:example': { timeline: { events: [{ type: 'm.room.message', content: { body } }], limited: true, prev_batch: 'p' }, state: { events: [{ type: 'm.room.encryption' }] } }, 'bad id': {} },
      invite: { '!b:example': { invite_state: { events: [{ type: 'm.room.name' }] } } }, leave: { '!c:example': {} } } }));
    await expect(client.createFilter({ room: {} })).resolves.toBe('7');
    const batch = await client.sync({ filter: '7', since: 's1', timeoutMs: 30_000 });
    const url = new URL(String(fetchImpl.mock.calls[1][0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({ filter: '7', since: 's1', timeout: '30000', set_presence: 'offline' });
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({ headers: { Authorization: 'Bearer SECRET' }, redirect: 'error' });
    expect(batch.nextBatch).toBe('s2');
    expect([...batch.joined.keys()]).toEqual(['!a:example']);
    expect(batch.joined.get('!a:example')).toMatchObject({ timeline: { limited: true, prev_batch: 'p' }, state: [{ type: 'm.room.encryption' }] });
    expect(batch.invited.get('!b:example')).toEqual([{ type: 'm.room.name' }]);
    expect(batch.left).toEqual(['!c:example']);
    fetchImpl.mockResolvedValueOnce(Response.json({ next_batch: 's3', filler: 'x'.repeat(17 * 1024 * 1024) }));
    await expect(client.sync({ filter: '7', timeoutMs: 0 })).rejects.toBeInstanceOf(ResponseTooLarge);
    fetchImpl.mockResolvedValueOnce(Response.json({}));
    await expect(client.sync({ filter: '7', timeoutMs: 0 })).rejects.toThrow('Invalid Matrix sync response');
  }, 20_000);

  it('waits past the poll\'s own timeout, and can be called off', async () => {
    vi.useFakeTimers();
    try {
      const { client, fetchImpl } = account();
      fetchImpl.mockImplementation(() => new Promise(() => {}));
      const settled = vi.fn();
      const poll = client.sync({ filter: '7', timeoutMs: 30_000 }).catch(settled);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      await poll;
      expect(settled.mock.calls[0][0]).toMatchObject({ message: 'HTTP request timed out', transient: true });
      const abort = new AbortController();
      const called = client.sync({ filter: '7', timeoutMs: 30_000, signal: abort.signal });
      abort.abort();
      await expect(called).rejects.toMatchObject({ message: 'HTTP request aborted', transient: true });
      expect(fetchImpl.mock.calls[1][1]?.signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('reads earlier events between two tokens', async () => {
    const { client, fetchImpl } = account();
    fetchImpl.mockResolvedValue(Response.json({ chunk: [{ type: 'm.room.message' }], end: 'e' }));
    await expect(client.messages('!room:example', 'from', 'to', ['m.room.message'])).resolves.toEqual({ events: [{ type: 'm.room.message' }], end: 'e' });
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.pathname).toBe('/_matrix/client/v3/rooms/!room%3Aexample/messages');
    expect(Object.fromEntries(url.searchParams)).toEqual({ dir: 'b', from: 'from', to: 'to', limit: '100', filter: '{"types":["m.room.message"]}' });
  });
});
