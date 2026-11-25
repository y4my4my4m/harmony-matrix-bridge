import { ghostOwner, type MatrixIdentity } from './config.js'
import type { BridgeMember } from './HarmonyClient.js'

type Part = Record<string, unknown>
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}
function decodeHtml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#39|#\d{1,7}|#x[\da-fA-F]{1,6});/g, entity => {
    const names: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" }
    if (names[entity]) return names[entity]
    const n = entity.startsWith('&#x') ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1))
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
  })
}
/** Text and tags of an HTML body, in one pass over it: what a stranger wrote costs no more than its length. */
function tokens(html: string): Array<{ text: string } | { tag: string }> {
  const found: Array<{ text: string } | { tag: string }> = []
  for (let at = 0; at < html.length;) {
    const open = html.indexOf('<', at)
    const close = open < 0 ? -1 : html.indexOf('>', open)
    if (close < 0) {
      found.push({ text: html.slice(at) })
      break
    }
    if (open > at) found.push({ text: html.slice(at, open) })
    found.push({ tag: html.slice(open + 1, close) })
    at = close + 1
  }
  return found
}
/** The text, and each matrix.to link with the text before it. */
function readHtml(html: string): { links: Array<{ before: string; label: string; target: string }>; after: string } {
  const list = tokens(html)
  const links: Array<{ before: string; label: string; target: string }> = []
  let text = ''
  let link: { start: number; target: string } | null = null
  for (let index = 0; index < list.length; index++) {
    const token = list[index]
    if ('text' in token) { text += decodeHtml(token.text); continue }
    const name = /^\/?[a-z0-9]{0,20}/i.exec(token.tag)![0].toLowerCase()
    if (name === 'br') text += '\n'
    else if (name === '/p') {
      const gap = list[index + 1]
      const blank = gap !== undefined && 'text' in gap && !gap.text.trim()
      const next = list[index + (blank ? 2 : 1)]
      if (next !== undefined && 'tag' in next && /^p(?:\s|$)/i.test(next.tag)) {
        text += '\n\n'
        index += blank ? 2 : 1
      }
    } else if (name === 'a' && link === null && token.tag.length <= 2048) {
      const target = /\shref\s*=\s*["'](https:\/\/matrix\.to\/#\/[^"']+)["']/i.exec(token.tag)?.[1]
      if (target !== undefined) link = { start: text.length, target }
    } else if (name === '/a' && link !== null) {
      links.push({ before: text.slice(0, link.start), label: text.slice(link.start), target: link.target })
      link = null
      text = ''
    }
  }
  return { links, after: text }
}
function nativeMention(member: BridgeMember): Part {
  return { type: 'mention', userId: member.id, username: member.username, domain: member.domain,
    isLocal: true, isBridged: false }
}

/** Only explicit annotations and validated matrix.to pills create notifications; never guessed names. */
export function matrixToHarmony(body: string, formatted: unknown, mentionIds: unknown, members: BridgeMember[], config: { matrix: MatrixIdentity }): Part[] {
  const eligible = new Map(members.map(member => [member.id, member]))
  const targets = new Map<string, BridgeMember>()
  if (Array.isArray(mentionIds) && mentionIds.length <= 100) {
    for (const id of mentionIds) {
      if (typeof id !== 'string') continue
      const owner = ghostOwner(config, id)
      if (owner && eligible.has(owner)) targets.set(id, eligible.get(owner)!)
    }
  }
  const command = /^!mention ([^\s]+) ([\s\S]+)$/.exec(body)
  if (command) {
    const matches = members.filter(member => member.username === command[1])
    if (matches.length === 1) return [nativeMention(matches[0]), { type: 'text', text: ` ${command[2]}` }]
  }
  if (!targets.size) return [{ type: 'text', text: body }]
  const parts: Part[] = []
  const used = new Set<string>()
  if (typeof formatted === 'string' && formatted.length <= 32_000) {
    // Parse only explicit anchors; no HTML, URL fetch or display-name replacement enters Harmony.
    const { links, after } = readHtml(formatted)
    let rendered = ''
    for (const link of links) {
      parts.push({ type: 'text', text: link.before })
      rendered += link.before + link.label
      let id = ''
      try { id = decodeURIComponent(decodeHtml(link.target).slice('https://matrix.to/#/'.length).split('?')[0]) } catch { /* Invalid URI is plain text. */ }
      const target = targets.get(id)
      parts.push(target ? nativeMention(target) : { type: 'text', text: link.label })
      if (target) used.add(id)
    }
    parts.push({ type: 'text', text: after })
    rendered += after
    // Reject HTML/plaintext disagreement rather than changing the sender's text.
    if (rendered.trim() !== body.trim()) { parts.length = 0; used.clear() }
  }
  if (!parts.length) parts.push({ type: 'text', text: body })
  for (const [id, member] of targets) if (!used.has(id)) parts.push({ type: 'text', text: ' ' }, nativeMention(member))
  return parts.filter(part => part.type !== 'text' || part.text !== '')
}

export function harmonyToMatrix(parts: Part[] | undefined, body: string, targets: Map<string, string>, prefix = ''): { body: string; userIds: string[]; formattedBody?: string } {
  if (!parts?.length) return { body: prefix + body, userIds: [] }
  let plain = prefix
  let html = escapeHtml(prefix)
  const ids = new Set<string>()
  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string') {
      plain += part.text
      html += escapeHtml(part.text).replace(/\n/g, '<br>')
    } else if (part.type === 'mention') {
      const label = `@${typeof part.username === 'string' ? part.username.slice(0, 100) : 'user'}`
      const id = typeof part.userId === 'string' && (!part.userId.startsWith('@') || (part.bridgeSource === 'matrix' && part.isBridged === true))
        ? targets.get(part.userId) : undefined
      plain += label
      if (id) {
        ids.add(id)
        html += `<a href="https://matrix.to/#/${encodeURIComponent(id)}">${escapeHtml(label)}</a>`
      } else html += escapeHtml(label)
    }
  }
  return { body: plain, userIds: [...ids], ...(ids.size ? { formattedBody: html } : {}) }
}
