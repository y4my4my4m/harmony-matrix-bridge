import { ROOM_ID } from './config.js';
import { endpoint, HttpError, requestJson, requestImage, requestFile, ResponseTooLarge, type AvatarImage, type FetchImpl } from './http.js';
import { MAX_MEDIA_BYTES, isInlineImage, mediaContentType, mediaName, type MediaFile, type MatrixFile } from './Media.js';

const mxcPattern = /^mxc:\/\/((?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\[[a-fA-F0-9:]+\])(?::[0-9]{1,5})?)\/([a-zA-Z0-9_-]+)$/;

export interface MatrixSendOptions { sender?: string; userIds?: string[]; formattedBody?: string; notice?: boolean; replyTo?: string }
export interface RoomMember { id: string; display_name?: string; avatar_mxc?: string }
export type Membership = 'join' | 'invite' | 'knock' | 'leave' | 'ban';
export interface RoomInfo {
  room_id: string; name: string | null; alias: string | null; encrypted: boolean; can_send: boolean; members: number | null;
}
export interface SyncRoom {
  timeline: { events: unknown[]; limited: boolean; prev_batch?: string };
  state: unknown[];
}
export interface SyncBatch {
  nextBatch: string;
  joined: Map<string, SyncRoom>;
  invited: Map<string, unknown[]>;
  left: string[];
}

export interface MatrixClientOptions {
  homeserverUrl: string;
  /** Application-service token, or an account's access token with `account`. */
  asToken: string;
  botUserId: string;
  /** An ordinary account: requests act as the token's owner and carry no `user_id`. */
  account?: boolean;
  /**
   * A ghost that exists and the bridge does not know is its own, from before its data was lost: the
   * name lies in the exclusive namespace and carries a profile's UUID. Off: refused.
   */
  adoptsGhosts?: boolean;
  fetchImpl?: FetchImpl;
}

interface RequestExtras { query?: Array<[string, string]>; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal }

// Largest joined_members and /sync answers read: about 40,000 members, or 1000 events of 16 KiB.
const MAX_MEMBERS_BYTES = 8 * 1024 * 1024;
const MAX_SYNC_BYTES = 16 * 1024 * 1024;
// Added to the long poll's own timeout before the connection is given up.
const SYNC_GRACE_MS = 30_000;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

/** One line of another person's text, without control or direction characters. */
export function plainText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.slice(0, max * 4).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean ? Array.from(clean).slice(0, max).join('') : null;
}
export function roomAlias(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 255 && /^#[^\s:\u0000-\u001f\u007f]+:[^\s/\u0000-\u001f\u007f]+$/.test(value) ? value : null;
}

export class MatrixClient {
  constructor(private readonly options: MatrixClientOptions) {}

  private request<T>(path: string, method: string, body?: unknown, sender = this.options.botUserId, extras: RequestExtras = {}): Promise<T> {
    const url = endpoint(this.options.homeserverUrl, `_matrix/client/v3/${path}`);
    if (!this.options.account) url.searchParams.set('user_id', sender);
    for (const [key, value] of extras.query ?? []) url.searchParams.append(key, value);
    return requestJson<T>(url, {
      method,
      headers: { Authorization: `Bearer ${this.options.asToken}`, 'Content-Type': 'application/json' },
      ...(extras.signal ? { signal: extras.signal } : {}),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, this.options.fetchImpl, extras.timeoutMs, extras.maxBytes);
  }

  private state<T>(roomId: string, type: string, key = '', query?: Array<[string, string]>): Promise<T> {
    return this.request<T>(`rooms/${encodeURIComponent(roomId)}/state/${type}/${encodeURIComponent(key)}`, 'GET', undefined, undefined, { query });
  }

  /** State content, or null for 404 M_NOT_FOUND. */
  private async optionalState(roomId: string, type: string, query?: Array<[string, string]>): Promise<Record<string, unknown> | null> {
    try { return object(await this.state<unknown>(roomId, type, '', query)); }
    catch (error) {
      if (error instanceof HttpError && error.status === 404 && error.errcode === 'M_NOT_FOUND') return null;
      throw error;
    }
  }

  async sendMessage(roomId: string, transactionId: string, body: string, options: MatrixSendOptions = {}): Promise<{ event_id: string }> {
    if (options.sender && options.sender !== this.options.botUserId) this.assertGhost(options.sender);
    const result = await this.request<{ event_id?: unknown }>(
      `rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(transactionId)}`,
      'PUT', { msgtype: options.notice ? 'm.notice' : 'm.text', body, 'm.mentions': options.userIds?.length ? { user_ids: options.userIds } : {},
        ...(options.replyTo ? { 'm.relates_to': { 'm.in_reply_to': { event_id: options.replyTo } } } : {}),
        ...(options.formattedBody ? { format: 'org.matrix.custom.html', formatted_body: options.formattedBody } : {}) }, options.sender,
    );
    if (typeof result?.event_id !== 'string' || !result.event_id) throw new HttpError('Invalid Matrix message response', false);
    return { event_id: result.event_id };
  }

  async downloadFile(mxc: string, name: string): Promise<MediaFile> {
    const match = mxcPattern.exec(mxc);
    if (!match || mxc.length > 2048) throw new HttpError('Invalid Matrix media URI', false);
    // Even remote MXC media goes through the configured authenticated homeserver.
    const url = endpoint(this.options.homeserverUrl,
      `_matrix/client/v1/media/download/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`);
    return requestFile(url, { method: 'GET', headers: { Authorization: `Bearer ${this.options.asToken}` } }, this.options.fetchImpl, name);
  }

  async uploadFile(file: MediaFile): Promise<string> {
    if (file.bytes.byteLength > MAX_MEDIA_BYTES) throw new HttpError('Attachment exceeds transfer limit', false);
    const url = endpoint(this.options.homeserverUrl, '_matrix/media/v3/upload');
    url.searchParams.set('filename', mediaName(file.name));
    const result = await requestJson<{ content_uri?: unknown }>(url, {
      method: 'POST', headers: { Authorization: `Bearer ${this.options.asToken}`, 'Content-Type': mediaContentType(file.contentType) },
      body: file.bytes,
    }, this.options.fetchImpl, 60_000);
    if (typeof result?.content_uri !== 'string' || result.content_uri.length > 2048 || !mxcPattern.test(result.content_uri)) throw new HttpError('Invalid Matrix media upload response', false);
    return result.content_uri;
  }

  async sendFile(roomId: string, transactionId: string, file: MatrixFile, options: MatrixSendOptions = {}): Promise<{ event_id: string }> {
    if (options.sender && options.sender !== this.options.botUserId) this.assertGhost(options.sender);
    if (file.mxc.length > 2048 || !mxcPattern.test(file.mxc) || !Number.isInteger(file.size) || file.size < 0 || file.size > MAX_MEDIA_BYTES) throw new HttpError('Invalid Matrix file', false);
    const name = mediaName(file.name);
    const contentType = mediaContentType(file.contentType);
    const result = await this.request<{ event_id?: unknown }>(
      `rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(transactionId)}`, 'PUT',
      { msgtype: isInlineImage(contentType) ? 'm.image' : 'm.file', body: name, filename: name,
        url: file.mxc, info: { mimetype: contentType, size: file.size }, 'm.mentions': {} }, options.sender,
    );
    if (typeof result?.event_id !== 'string' || !result.event_id) throw new HttpError('Invalid Matrix message response', false);
    return { event_id: result.event_id };
  }

  async roomMember(roomId: string, userId: string): Promise<{ display_name?: string; avatar_mxc?: string }> {
    const member = await this.request<{ membership?: unknown; displayname?: unknown; avatar_url?: unknown }>(
      `rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(userId)}`, 'GET',
    );
    if (member?.membership !== 'join') throw new HttpError('Matrix sender is not a joined room member', false);
    const name = member.displayname;
    const result: { display_name?: string; avatar_mxc?: string } = {};
    if (typeof name === 'string' && name.trim() && name.length <= 100 && !/[\u0000-\u001f\u007f]/.test(name)) result.display_name = name;
    if (typeof member.avatar_url === 'string' && member.avatar_url.length <= 2048
      && mxcPattern.test(member.avatar_url)) result.avatar_mxc = member.avatar_url;
    return result;
  }

  async avatarThumbnail(mxc: string): Promise<AvatarImage> {
    const match = mxcPattern.exec(mxc);
    if (!match || mxc.length > 2048) throw new HttpError('Invalid Matrix avatar URI', false);
    // Always ask the configured HS; the MXC server is only an encoded path component.
    const url = endpoint(this.options.homeserverUrl,
      `_matrix/client/v1/media/thumbnail/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`);
    url.search = new URLSearchParams({ width: '128', height: '128', method: 'scale' }).toString();
    return requestImage(url, { method: 'GET', headers: { Authorization: `Bearer ${this.options.asToken}` } }, this.options.fetchImpl);
  }

  private assertGhost(id: string): void {
    if (this.options.account) throw new HttpError('An ordinary account has no ghosts', false);
    const colon = this.options.botUserId.indexOf(':');
    const prefix = `${this.options.botUserId.slice(0, colon)}_h_`;
    const suffix = this.options.botUserId.slice(colon);
    if (!id.startsWith(prefix) || !id.endsWith(suffix) || !/^[0-9a-f]{32}$/.test(id.slice(prefix.length, -suffix.length))) {
      throw new HttpError('Sender outside dedicated ghost namespace', false);
    }
  }

  async registerGhost(id: string, previouslyRegistered: boolean): Promise<void> {
    this.assertGhost(id);
    try {
      await requestJson(endpoint(this.options.homeserverUrl, '_matrix/client/v3/register'), {
        method: 'POST', headers: { Authorization: `Bearer ${this.options.asToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'm.login.application_service', username: id.slice(1, id.indexOf(':')) }),
      }, this.options.fetchImpl);
    } catch (error) {
      if (!(error instanceof HttpError && error.errcode === 'M_USER_IN_USE' && (previouslyRegistered || this.options.adoptsGhosts))) throw error;
    }
    const who = await this.request<{ user_id?: unknown }>('account/whoami', 'GET', undefined, id);
    if (who?.user_id !== id) throw new HttpError('Application service cannot own ghost sender', false);
  }

  async joinGhost(roomId: string, id: string, profile: { displayname: string; avatar_url?: string }): Promise<void> {
    this.assertGhost(id);
    let joined = false;
    let unchanged = false;
    let currentAvatar: string | undefined;
    try {
      const member = await this.request<{ membership?: unknown; displayname?: unknown; avatar_url?: unknown }>(`rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(id)}`, 'GET');
      joined = member?.membership === 'join';
      currentAvatar = typeof member?.avatar_url === 'string' ? member.avatar_url : undefined;
      unchanged = joined && member.displayname === profile.displayname && (profile.avatar_url === undefined || (currentAvatar || '') === profile.avatar_url);
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 404 && error.errcode === 'M_NOT_FOUND')) throw error;
    }
    if (!joined) {
      // A public room takes a ghost without an invite, which the bridge may lack the power for there.
      const join = () => this.request(`join/${encodeURIComponent(roomId)}`, 'POST', {}, id);
      try { await join(); }
      catch (error) {
        if (!(error instanceof HttpError && error.status === 403)) throw error;
        await this.request(`rooms/${encodeURIComponent(roomId)}/invite`, 'POST', { user_id: id });
        await join();
      }
    }
    const avatar = profile.avatar_url === undefined ? currentAvatar : profile.avatar_url;
    if (!unchanged) await this.request(`rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(id)}`, 'PUT', {
      membership: 'join', displayname: profile.displayname, ...(avatar !== undefined ? { avatar_url: avatar } : {}),
    }, id);
  }

  async leaveGhost(roomId: string, id: string): Promise<void> {
    this.assertGhost(id);
    await this.request(`rooms/${encodeURIComponent(roomId)}/leave`, 'POST', {}, id);
  }

  async leaveRoom(roomId: string, reason?: string): Promise<void> {
    await this.request(`rooms/${encodeURIComponent(roomId)}/leave`, 'POST', reason === undefined ? {} : { reason });
  }

  async uploadAvatar(image: AvatarImage): Promise<string> {
    const result = await requestJson<{ content_uri?: unknown }>(endpoint(this.options.homeserverUrl, '_matrix/media/v3/upload'), {
      method: 'POST', headers: { Authorization: `Bearer ${this.options.asToken}`, 'Content-Type': image.content_type },
      body: Buffer.from(image.data, 'base64'),
    }, this.options.fetchImpl);
    if (typeof result?.content_uri !== 'string' || result.content_uri.length > 2048 || !mxcPattern.test(result.content_uri)) throw new HttpError('Invalid Matrix avatar upload response', false);
    return result.content_uri;
  }

  async roomMembers(roomId: string): Promise<RoomMember[]> {
    const result = await this.request<{ joined?: Record<string, { display_name?: unknown; avatar_url?: unknown }> }>(
      `rooms/${encodeURIComponent(roomId)}/joined_members`, 'GET', undefined, undefined, { maxBytes: MAX_MEMBERS_BYTES });
    if (!result?.joined || typeof result.joined !== 'object' || Array.isArray(result.joined)) throw new HttpError('Invalid Matrix membership', false);
    return Object.entries(result.joined).filter(([id]) => id.length <= 255 && /^@[^\s:]+:[^\s/]+$/.test(id)).map(([id, member]) => ({ id,
      ...(typeof member?.display_name === 'string' && member.display_name.length <= 100 && !/[\u0000-\u001f\u007f]/.test(member.display_name) ? { display_name: member.display_name } : {}),
      ...(typeof member?.avatar_url === 'string' && member.avatar_url.length <= 2048 && mxcPattern.test(member.avatar_url) ? { avatar_mxc: member.avatar_url } : {}),
    }));
  }

  async roomIsPlaintext(roomId: string): Promise<boolean> {
    try {
      await this.state(roomId, 'm.room.encryption');
      return false;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404 && error.errcode === 'M_NOT_FOUND') return true;
      throw error;
    }
  }

  async ensureRegistered(): Promise<void> {
    const match = /^@([^:]+):.+$/.exec(this.options.botUserId);
    if (!match) throw new HttpError('Invalid Matrix bot user ID', false);
    try {
      await requestJson(endpoint(this.options.homeserverUrl, '_matrix/client/v3/register'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.asToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'm.login.application_service', username: match[1] }),
      }, this.options.fetchImpl);
    } catch (error) {
      if (error instanceof HttpError && error.errcode === 'M_USER_IN_USE') return;
      throw error;
    }
  }

  /** `via`: servers to join through, beside the one a room ID names. */
  async joinRoom(roomId: string, via: string[] = []): Promise<void> {
    const colon = roomId.indexOf(':');
    const servers = [...new Set([...via, ...(colon > 0 ? [roomId.slice(colon + 1)] : [])])].slice(0, 5);
    // `server_name` is the name of `via` before Matrix 1.12.
    await this.request(`join/${encodeURIComponent(roomId)}`, 'POST', {}, undefined, {
      query: servers.flatMap((server): Array<[string, string]> => [['via', server], ['server_name', server]]), timeoutMs: 60_000,
    });
  }

  /** The application service's hold on its sender: refused while the homeserver does not know the registration. */
  async verifySender(): Promise<void> {
    if (await this.whoami() !== this.options.botUserId) throw new HttpError('Application service cannot own its sender', false);
  }

  async whoami(): Promise<string> {
    const who = await this.request<{ user_id?: unknown }>('account/whoami', 'GET');
    if (typeof who?.user_id !== 'string' || who.user_id.length > 255 || !/^@[^\s:]+:[^\s/]+$/.test(who.user_id)) throw new HttpError('Invalid Matrix account', false);
    return who.user_id;
  }

  async resolveAlias(alias: string): Promise<{ roomId: string; servers: string[] }> {
    const result = await this.request<{ room_id?: unknown; servers?: unknown }>(`directory/room/${encodeURIComponent(alias)}`, 'GET', undefined, undefined, { timeoutMs: 60_000 });
    if (typeof result?.room_id !== 'string' || result.room_id.length > 255 || !ROOM_ID.test(result.room_id)) throw new HttpError('Invalid Matrix room alias', false);
    return { roomId: result.room_id, servers: list(result.servers).filter((server): server is string => typeof server === 'string' && server.length <= 255).slice(0, 5) };
  }

  /** The bridge's own membership; null when the homeserver does not show it. */
  async membership(roomId: string): Promise<Membership | null> {
    try {
      const member = await this.state<{ membership?: unknown }>(roomId, 'm.room.member', this.options.botUserId);
      return ['join', 'invite', 'knock', 'leave', 'ban'].includes(String(member?.membership)) ? member.membership as Membership : null;
    } catch (error) {
      if (error instanceof HttpError && (error.status === 403 || error.status === 404)) return null;
      throw error;
    }
  }

  /** Whether the bridge's own user may send messages, by the room's power levels. */
  async canSend(roomId: string): Promise<boolean> {
    const user = this.options.botUserId;
    const levels = await this.optionalState(roomId, 'm.room.power_levels');
    if (!levels) return true;
    const level = (value: unknown, fallback: number) => value !== undefined && Number.isFinite(Number(value)) ? Number(value) : fallback;
    const own = level(object(levels.users)[user], level(levels.users_default, 0));
    if (own >= level(object(levels.events)['m.room.message'], level(levels.events_default, 0))) return true;
    // Room version 12: creators hold every power and appear in no power_levels.
    const create = await this.optionalState(roomId, 'm.room.create', [['format', 'event']]);
    const content = object(create?.content);
    return Number(content.room_version) >= 12 && (create?.sender === user || list(content.additional_creators).includes(user));
  }

  /** Whether someone has the power to change what a room is: its state, and its power levels. */
  async mayChangeRoom(roomId: string, userId: string): Promise<boolean> {
    const create = await this.optionalState(roomId, 'm.room.create', [['format', 'event']]);
    const content = object(create?.content);
    const creator = create?.sender === userId;
    // Room version 12: creators hold every power, power_levels or not.
    if (Number(content.room_version) >= 12 && (creator || list(content.additional_creators).includes(userId))) return true;
    const levels = await this.optionalState(roomId, 'm.room.power_levels');
    // Without power levels nobody but the creator has any.
    if (!levels) return creator;
    // Rooms before version 10 may hold numbers as text. What is no number gives no power and lowers no bar.
    const level = (value: unknown, fallback: number) => value === undefined ? fallback : Number.isSafeInteger(Number(value)) && value !== '' && value !== null ? Number(value) : NaN;
    const own = level(object(levels.users)[userId], level(levels.users_default, 0));
    const state = level(levels.state_default, 50);
    return own >= state && own >= level(object(levels.events)['m.room.power_levels'], state);
  }

  async joinedRooms(): Promise<string[]> {
    const result = await this.request<{ joined_rooms?: unknown }>('joined_rooms', 'GET');
    return list(result?.joined_rooms).filter((id): id is string => typeof id === 'string' && id.length <= 255 && ROOM_ID.test(id));
  }

  /** Rooms the account keeps as direct chats (account data m.direct). */
  async directRooms(): Promise<Set<string>> {
    try {
      const direct = await this.request<unknown>(`user/${encodeURIComponent(this.options.botUserId)}/account_data/m.direct`, 'GET');
      return new Set(Object.values(object(direct)).flatMap(list).filter((id): id is string => typeof id === 'string'));
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return new Set();
      throw error;
    }
  }

  /** A joined room as the status report lists it; null for a space. */
  async roomInfo(roomId: string): Promise<RoomInfo | null> {
    if ((await this.optionalState(roomId, 'm.room.create'))?.type === 'm.space') return null;
    const name = plainText((await this.optionalState(roomId, 'm.room.name'))?.name, 100);
    const alias = roomAlias((await this.optionalState(roomId, 'm.room.canonical_alias'))?.alias);
    const encrypted = !await this.roomIsPlaintext(roomId);
    let members: number | null = null;
    try { members = (await this.roomMembers(roomId)).length; }
    catch (error) { if (!(error instanceof ResponseTooLarge)) throw error; }
    return { room_id: roomId, name, alias, encrypted, can_send: await this.canSend(roomId), members };
  }

  async createFilter(filter: Record<string, unknown>): Promise<string> {
    const result = await this.request<{ filter_id?: unknown }>(`user/${encodeURIComponent(this.options.botUserId)}/filter`, 'POST', filter);
    if (typeof result?.filter_id !== 'string' || !result.filter_id) throw new HttpError('Invalid Matrix filter response', false);
    return result.filter_id;
  }

  async sync(options: { filter: string; since?: string; timeoutMs: number; signal?: AbortSignal }): Promise<SyncBatch> {
    const result = object(await this.request<unknown>('sync', 'GET', undefined, undefined, {
      query: [['filter', options.filter], ['timeout', String(options.timeoutMs)], ['set_presence', 'offline'], ...(options.since ? [['since', options.since] as [string, string]] : [])],
      timeoutMs: options.timeoutMs + SYNC_GRACE_MS, maxBytes: MAX_SYNC_BYTES, signal: options.signal,
    }));
    if (typeof result.next_batch !== 'string' || !result.next_batch) throw new HttpError('Invalid Matrix sync response', false);
    const rooms = object(result.rooms);
    const entries = (value: unknown) => Object.entries(object(value)).filter(([id]) => id.length <= 255 && ROOM_ID.test(id));
    return {
      nextBatch: result.next_batch,
      joined: new Map(entries(rooms.join).map(([id, value]) => {
        const room = object(value);
        const timeline = object(room.timeline);
        return [id, { timeline: { events: list(timeline.events), limited: timeline.limited === true,
          ...(typeof timeline.prev_batch === 'string' ? { prev_batch: timeline.prev_batch } : {}) }, state: list(object(room.state).events) }];
      })),
      invited: new Map(entries(rooms.invite).map(([id, value]) => [id, list(object(object(value).invite_state).events)])),
      left: entries(rooms.leave).map(([id]) => id),
    };
  }

  /** One page of a room's earlier events, newest first, down to `to`. */
  async messages(roomId: string, from: string, to: string, types: string[]): Promise<{ events: unknown[]; end?: string }> {
    const result = object(await this.request<unknown>(`rooms/${encodeURIComponent(roomId)}/messages`, 'GET', undefined, undefined, {
      query: [['dir', 'b'], ['from', from], ['to', to], ['limit', '100'], ['filter', JSON.stringify({ types })]],
      timeoutMs: 60_000, maxBytes: MAX_SYNC_BYTES,
    }));
    return { events: list(result.chunk), ...(typeof result.end === 'string' ? { end: result.end } : {}) };
  }
}
