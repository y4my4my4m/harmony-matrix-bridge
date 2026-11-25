import { describe, expect, it, vi } from 'vitest'
import { EndpointError, normalizeHarmonyUrl, probeEndpoints } from './endpoints.js'

const answering = (healthy: string[]) => vi.fn<typeof fetch>(async input => healthy.includes(String(input))
  ? Response.json({ status: 'ok' }) : new Response('<html>', { status: 404 }))

describe('endpoints', () => {
  it('normalizes addresses', () => {
    expect(normalizeHarmonyUrl(' har.mony.lol/ ')).toBe('https://har.mony.lol')
    expect(normalizeHarmonyUrl('http://localhost:3002/?x=1#y')).toBe('http://localhost:3002')
    for (const bad of ['http://', 'ftp://host', 'https://a:b@host']) expect(() => normalizeHarmonyUrl(bad)).toThrow()
  })
  it('finds the gateway behind the site, or the gateway itself', async () => {
    await expect(probeEndpoints('https://harmony.test', answering(['https://harmony.test/bot-gateway/health']))).resolves
      .toEqual({ apiBase: 'https://harmony.test/bot-gateway', gatewayUrl: 'wss://harmony.test/bot-gateway/gateway', direct: false })
    await expect(probeEndpoints('http://localhost:3002', answering(['http://localhost:3002/health']))).resolves
      .toEqual({ apiBase: 'http://localhost:3002', gatewayUrl: 'ws://localhost:3002/gateway', direct: true })
    const none = vi.fn<typeof fetch>()
    await expect(probeEndpoints('https://harmony.test/bot-gateway', none)).resolves.toMatchObject({ apiBase: 'https://harmony.test/bot-gateway' })
    expect(none).not.toHaveBeenCalled()
  })
  it('tells an address without a gateway from one that does not answer', async () => {
    await expect(probeEndpoints('https://harmony.test', answering([]))).rejects.toMatchObject({ unreachable: false })
    const down = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED SECRET'))
    const error = await probeEndpoints('https://harmony.test', down).catch(error => error)
    expect(error).toBeInstanceOf(EndpointError)
    expect(error.unreachable).toBe(true)
    expect(error.message).not.toContain('SECRET')
    await expect(probeEndpoints('https://harmony.test', vi.fn<typeof fetch>(async () => new Response('', { status: 502 })))).rejects.toMatchObject({ unreachable: true })
  })
})
