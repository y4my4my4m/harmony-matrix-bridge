import { Store } from './Store.js'

/** A room the instance's account is in on the bridge's behalf: one it was invited to, or a pair's. */
export interface HostRoom {
  roomId: string
  /** The bridge it was linked with or paired by last; null: none yet. */
  bridgeId: string | null
  /** Epoch ms, since when no pair is known for it; null while there is one. */
  waitingSince: number | null
}

const TRY_WINDOW_MS = 10 * 60_000
const TRIES = 5
const TRIES_KEPT = 10_000

/** What the instance's bridges share: ghosts, invites, the sync token, the rooms the account is in, and tries to link one. */
export class HostStore extends Store {
  constructor(path: string) {
    super(path)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS host_rooms (
        room_id TEXT PRIMARY KEY NOT NULL,
        bridge_id TEXT,
        waiting_since INTEGER
      );
      CREATE TABLE IF NOT EXISTS link_tries (
        event_id TEXT PRIMARY KEY NOT NULL,
        sender TEXT NOT NULL,
        at INTEGER NOT NULL,
        counted INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS link_tries_sender ON link_tries(sender, at);
    `)
  }

  rooms(): HostRoom[] {
    return this.ghostState(() => this.db.prepare('SELECT * FROM host_rooms ORDER BY rowid').all().map(row => ({
      roomId: row.room_id as string, bridgeId: row.bridge_id as string | null, waitingSince: row.waiting_since as number | null,
    })))
  }

  saveRoom(room: HostRoom): void {
    this.ghostState(() => this.db.prepare(`
      INSERT INTO host_rooms(room_id, bridge_id, waiting_since) VALUES (?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET bridge_id = excluded.bridge_id, waiting_since = excluded.waiting_since
    `).run(room.roomId, room.bridgeId, room.waitingSince))
  }

  dropRoom(roomId: string): void {
    this.ghostState(() => this.db.prepare('DELETE FROM host_rooms WHERE room_id = ?').run(roomId))
  }

  /** A command's event, once. 'repeated': a homeserver told of it before; 'refused': its sender tried too often. */
  takeTry(eventId: string, sender: string, now = Date.now()): 'taken' | 'repeated' | 'refused' {
    return this.ghostState(() => this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM link_tries WHERE event_id = ?').get(eventId)) return 'repeated'
      const used = this.db.prepare('SELECT COUNT(*) AS count FROM link_tries WHERE sender = ? AND at > ? AND counted = 1').get(sender, now - TRY_WINDOW_MS)!.count as number
      const taken = used < TRIES
      this.db.prepare('INSERT INTO link_tries(event_id, sender, at, counted) VALUES (?, ?, ?, ?)').run(eventId, sender, now, taken ? 1 : 0)
      this.db.prepare('DELETE FROM link_tries WHERE rowid NOT IN (SELECT rowid FROM link_tries ORDER BY rowid DESC LIMIT ?)').run(TRIES_KEPT)
      return taken ? 'taken' : 'refused'
    }))
  }
}
