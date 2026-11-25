import { isIP } from 'node:net'
import { httpUrl } from './config.js'
import { endpoint, requestJson, type FetchImpl } from './http.js'

function ownHost(url: URL): string { return url.hostname.replace(/^\[|\]$/g, '').toLowerCase() }

/** Loopback, RFC 1918, link-local and unique local addresses, and localhost. */
export function isPrivateAddress(address: string): boolean {
  let host: string
  try { host = ownHost(new URL(address)) } catch { return false }
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (isIP(host) === 4) return /^(?:127|10)\.|^192\.168\.|^169\.254\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
  // URL writes an IPv4-mapped address as ::ffff:7f00:1; none of its forms is taken as private.
  return isIP(host) === 6 && /^(?:::1$|f[cd]|fe[89ab])/.test(host)
}

/** Whether a password or token may go there: https, or a private address. */
export function isSafeForSecrets(address: string): boolean {
  return address.startsWith('https://') || (address.startsWith('http://') && isPrivateAddress(address))
}

/**
 * The client API behind an address: what its .well-known/matrix/client names, else the address
 * itself. An answer that gives up https is not taken, nor http on another host. Redirects are not
 * followed.
 */
export async function discoverHomeserver(address: string, fetchImpl?: FetchImpl): Promise<string> {
  const own = address.replace(/\/+$/, '')
  let named: unknown
  try {
    const body = await requestJson<{ 'm.homeserver'?: { base_url?: unknown } }>(endpoint(own, '.well-known/matrix/client'), { method: 'GET' }, fetchImpl)
    named = body?.['m.homeserver']?.base_url
  } catch { return own }
  const parsed = httpUrl.safeParse(named)
  if (!parsed.success) return own
  const base = parsed.data.replace(/\/+$/, '')
  if (base.startsWith('https://')) return base
  return own.startsWith('http://') && ownHost(new URL(base)) === ownHost(new URL(own)) ? base : own
}
