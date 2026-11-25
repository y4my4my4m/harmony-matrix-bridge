import { endpoint, HttpError, requestJson, type FetchImpl } from './http.js'

export interface HarmonyEndpoints {
  /** bot-gateway root: REST is `${apiBase}/api/v1`, the bridge routes `${apiBase}/bridge/v2/matrix`. */
  apiBase: string
  gatewayUrl: string
  /** HARMONY_URL names bot-gateway itself rather than the public site. */
  direct: boolean
}

export class EndpointError extends Error {
  constructor(message: string, readonly unreachable: boolean) { super(message) }
}

/** Throws with a message for the operator. */
export function normalizeHarmonyUrl(raw: string): string {
  let text = raw.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`
  let url: URL
  try { url = new URL(text) }
  catch { throw new Error('HARMONY_URL is not a valid address (expected something like https://har.mony.lol)') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('HARMONY_URL must start with https:// or http://')
  if (url.username || url.password) throw new Error('HARMONY_URL must not hold credentials')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

export function endpointsFor(apiBase: string, direct: boolean): HarmonyEndpoints {
  const base = apiBase.replace(/\/+$/, '')
  return { apiBase: base, gatewayUrl: `${base.replace(/^http/i, 'ws')}/gateway`, direct }
}

async function answersHealth(base: string, fetchImpl?: FetchImpl): Promise<boolean> {
  try {
    const body = await requestJson<{ status?: unknown }>(endpoint(base, 'health'), { method: 'GET' }, fetchImpl)
    return body?.status === 'ok'
  } catch (error) {
    if (error instanceof HttpError && !error.transient) return false
    throw error
  }
}

/**
 * bot-gateway from HARMONY_URL: a URL ending in /bot-gateway as it is, the site's /bot-gateway,
 * or the URL itself when it is the gateway (http://localhost:3002).
 */
export async function probeEndpoints(harmonyUrl: string, fetchImpl?: FetchImpl): Promise<HarmonyEndpoints> {
  const base = harmonyUrl.replace(/\/+$/, '')
  if (/\/bot-gateway$/i.test(base)) return endpointsFor(base, false)
  let unreachable = false
  for (const [candidate, direct] of [[`${base}/bot-gateway`, false], [base, true]] as const) {
    try { if (await answersHealth(candidate, fetchImpl)) return endpointsFor(candidate, direct) }
    catch { unreachable = true }
  }
  if (unreachable) throw new EndpointError('Cannot reach Harmony at HARMONY_URL', true)
  throw new EndpointError('HARMONY_URL answers, but no Harmony bot gateway was found there. Check the address, and that bots are enabled on that Harmony.', false)
}
