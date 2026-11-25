import { lookup as systemLookup, Resolver } from 'node:dns/promises'
import { Agent, request } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { Readable } from 'node:stream'
import type { FetchImpl } from './http.js'

const reserved = new BlockList()
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) reserved.addSubnet(network, prefix, 'ipv4')
// Global unicast is 2000::/3. Everything else (mapped, NAT64, unique local, link-local, multicast) lies outside it.
const global = new BlockList()
global.addSubnet('2000::', 3, 'ipv6')
const special = new BlockList()
// IETF assignments with Teredo, documentation, 6to4, documentation.
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) special.addSubnet(network, prefix, 'ipv6')

/** An address anyone on the internet could reach. */
export function isPublicAddress(address: string | undefined): boolean {
  switch (isIP(address ?? '')) {
    case 4: return !reserved.check(address!, 'ipv4')
    case 6: return !address!.includes('%') && global.check(address!, 'ipv6') && !special.check(address!, 'ipv6')
    default: return false
  }
}

const MAX_ADDRESSES = 16
const RESOLVE_MS = 3_000

/** By DNS itself: getaddrinfo holds threads that every other bridge's lookups need. */
async function resolveByDns(hostname: string): Promise<string[]> {
  const resolver = new Resolver({ timeout: RESOLVE_MS, tries: 2 })
  const answers = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)])
  return answers.flatMap(answer => answer.status === 'fulfilled' ? answer.value : [])
}

/** As the system resolves names, /etc/hosts and local domains included. */
async function resolveBySystem(hostname: string): Promise<string[]> {
  return (await systemLookup(hostname, { all: true })).map(({ address }) => address)
}

export interface GuardOptions {
  /** The addresses that may be connected to; default: public ones. */
  allows?: (address: string | undefined) => boolean
  resolve?: (hostname: string) => Promise<string[]>
  /** Certificate authority beside the known ones. */
  ca?: string | Buffer
}

/** `anyAddress`: private ones too, as the operator allows. */
export function homeserverFetch(anyAddress: boolean): FetchImpl {
  return guardedFetch(anyAddress ? { allows: address => isIP(address ?? '') !== 0, resolve: resolveBySystem } : {})
}

/**
 * fetch for an address a stranger chose: https, no redirects, and only to addresses `allows` takes,
 * judged at every connection. Bodies and times are bounded by the caller.
 */
export function guardedFetch(options: GuardOptions = {}): FetchImpl {
  const { allows = isPublicAddress, resolve = resolveByDns } = options
  const addresses = async (hostname: string, family: number) => {
    const found = (await resolve(hostname)).slice(0, MAX_ADDRESSES).filter(allows).map(address => ({ address, family: isIP(address) }))
    const usable = found.filter(entry => family === 0 || entry.family === family)
    if (!usable.length) throw new Error('No address that may be connected to')
    return usable
  }
  const lookup: LookupFunction = (hostname, { all, family }, callback) => {
    const wanted = family === 4 || family === 6 ? family : family === 'IPv4' ? 4 : family === 'IPv6' ? 6 : 0
    addresses(hostname, wanted).then(
      found => { if (all) callback(null, found); else callback(null, found[0].address, found[0].family) },
      error => callback(error as Error, ''))
  }
  class GuardedAgent extends Agent {
    override createConnection(...args: Parameters<Agent['createConnection']>): ReturnType<Agent['createConnection']> {
      const socket = super.createConnection(...args)
      // The address itself, however it was found. Nothing of the request is written before this.
      const connected = socket as unknown as { once(event: 'connect', run: () => void): void; remoteAddress?: string; destroy(error: Error): void } | null | undefined
      connected?.once('connect', () => { if (!allows(connected.remoteAddress)) connected.destroy(new Error('Address refused')) })
      return socket
    }
  }
  const agent = new GuardedAgent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 4, timeout: 90_000, ...(options.ca ? { ca: options.ca } : {}) })

  return (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(input)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    // A literal address is not looked up.
    if (url.protocol !== 'https:' || (isIP(host) !== 0 && !allows(host))) throw new Error('Address refused')
    const body = init.body === undefined || init.body === null ? undefined : Buffer.from(init.body as string | Uint8Array)
    const headers: Record<string, string> = { 'user-agent': 'harmony-matrix-bridge', ...(body ? { 'content-length': String(body.length) } : {}) }
    new Headers(init.headers).forEach((value, name) => { headers[name] = value })
    headers['accept-encoding'] = 'identity'
    return new Promise<Response>((settle, reject) => {
      const req = request(url, { method: init.method ?? 'GET', headers, agent, lookup, signal: init.signal ?? undefined }, res => {
        const status = res.statusCode ?? 0
        if (status < 200 || status > 599 || (status >= 300 && status < 400)) {
          res.destroy()
          reject(new Error('Unexpected answer'))
          return
        }
        const answer = new Headers()
        for (let index = 0; index < res.rawHeaders.length; index += 2) {
          try { answer.append(res.rawHeaders[index], res.rawHeaders[index + 1]) } catch { /* Not a header fetch knows. */ }
        }
        const empty = status === 204 || status === 205
        if (empty) res.resume()
        // A break after the headers reaches the reader through the stream.
        settle(new Response(empty ? null : Readable.toWeb(res) as ReadableStream, { status, headers: answer }))
      })
      req.on('error', reject)
      req.end(body)
    })
  }) as FetchImpl
}
