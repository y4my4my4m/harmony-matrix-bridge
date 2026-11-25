import { timingSafeEqual, createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { z } from 'zod'
import type { MatrixEvent } from './Relay.js'

const eventSchema = z.object({
  type: z.string().max(255),
  event_id: z.string().max(255).optional(),
  room_id: z.string().max(255).optional(),
  sender: z.string().max(255).optional(),
  content: z.record(z.string(), z.unknown()).optional(),
}).passthrough()
// A transaction holds up to 100 events of at most 64 KiB each.
const MAX_BODY = 8 * 1024 * 1024
// The homeserver repeats a refused transaction for ever, and no room's events pass it. One that cannot
// be read is refused this often, for a body damaged on the way, and then let go.
const UNREADABLE_TRIES = 3
const MAX_UNREADABLE = 100

/** The events that can be read. Of one that cannot, an encryption event still fences its room. */
function readableEvents(values: unknown[]): MatrixEvent[] {
  const events: MatrixEvent[] = []
  for (const value of values) {
    const parsed = eventSchema.safeParse(value)
    if (parsed.success) { events.push(parsed.data as MatrixEvent); continue }
    const { type, room_id } = (value ?? {}) as { type?: unknown; room_id?: unknown }
    if (type === 'm.room.encryption' && typeof room_id === 'string') events.push({ type, room_id })
  }
  return events
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY) throw Object.assign(new Error('Request too large'), { status: 413 })
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }) }
}

export interface ServiceStatus { ready: boolean; pending: number; failed: number; problems?: string[] }
export interface AppServiceOptions {
  hsToken: string
  botUserId: string
  ownsGhost?: (id: string) => boolean
  acceptTransaction: (id: string, events: MatrixEvent[]) => boolean
  status: () => ServiceStatus
  report?: (message: string) => void
}

/** GET /health alone, for a bridge no homeserver calls. */
export function createHealthServer(status: () => ServiceStatus): Server {
  const server = createServer((req, res) => {
    const found = req.method === 'GET' && (req.url ?? '/').split('?')[0] === '/health'
    let code = 404
    let report: ServiceStatus | { error: string } = { error: 'Not found' }
    if (found) {
      try { report = status(); code = report.ready ? 200 : 503 }
      catch { report = { error: 'Status not available' }; code = 503 }
    }
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(report))
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  return server
}

/** Authenticate before parsing; acknowledge a transaction only after durable acceptance. */
export function createAppServiceHandler(options: AppServiceOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const expected = createHash('sha256').update(`Bearer ${options.hsToken}`).digest()
  const unreadable = new Map<string, number>()
  return async (req, res) => {
    const respond = (status: number, payload: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(payload))
    }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/health') {
        const status = options.status()
        respond(status.ready ? 200 : 503, status)
        return
      }
      const actual = createHash('sha256').update(req.headers.authorization ?? '').digest()
      if (!timingSafeEqual(expected, actual)) {
        respond(401, { errcode: 'M_UNAUTHORIZED', error: 'Invalid application-service authentication' })
        return
      }
      const match = /^\/_matrix\/app\/v1\/transactions\/([^/]+)$/.exec(url.pathname)
      if (req.method === 'PUT' && match) {
        let id: string
        try { id = decodeURIComponent(match[1]) } catch { respond(400, { error: 'Invalid transaction ID' }); return }
        if (!id || id.length > 255) { respond(400, { error: 'Invalid transaction ID' }); return }
        let events: unknown
        let failure = 400
        try { events = (await body(req) as { events?: unknown } | null)?.events }
        catch (error) {
          const status = (error as { status?: number }).status
          if (status !== 400 && status !== 413) throw error
          failure = status
        }
        if (!Array.isArray(events)) {
          const tries = (unreadable.get(id) ?? 0) + 1
          if (tries < UNREADABLE_TRIES) {
            if (unreadable.size >= MAX_UNREADABLE) unreadable.delete(unreadable.keys().next().value!)
            unreadable.set(id, tries)
            respond(failure, { errcode: 'M_BAD_JSON', error: 'Invalid transaction' })
            return
          }
          unreadable.delete(id)
          options.report?.('The homeserver sent a transaction that cannot be read; its events were not copied')
          respond(200, {})
          return
        }
        options.acceptTransaction(id, readableEvents(events))
        unreadable.delete(id)
        respond(200, {})
        return
      }
      const user = /^\/_matrix\/app\/v1\/users\/([^/]+)$/.exec(url.pathname)
      if (req.method === 'GET' && user && (decodeURIComponent(user[1]) === options.botUserId || options.ownsGhost?.(decodeURIComponent(user[1])))) {
        respond(200, {})
        return
      }
      if (req.method === 'POST' && url.pathname === '/_matrix/app/v1/ping') {
        await body(req)
        respond(200, {})
        return
      }
      respond(404, { errcode: 'M_NOT_FOUND', error: 'Not found' })
    } catch (error) {
      const status = (error as { status?: number }).status
      respond(status === 400 || status === 413 ? status : 503, { error: 'Transaction not accepted' })
    }
  }
}

/** Bounds for a server that a homeserver calls. */
export function boundedServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server {
  const server = createServer(handler)
  server.requestTimeout = 60_000
  server.headersTimeout = 10_000
  server.timeout = 60_000
  server.maxRequestsPerSocket = 100
  return server
}

export function createAppService(options: AppServiceOptions): Server {
  const handler = createAppServiceHandler(options)
  return boundedServer((req, res) => { void handler(req, res) })
}
