/** Without the quote of the message replied to that older clients put first. */
export function withoutQuote(body: string): string {
  return body.replace(/^(?:> [^\n]*(?:\n|$))+(?:\r?\n)?/, '')
}

const COMMAND = /^\s*!harmony(?:\s+link(?:\s|$)|\s*$)/i

/** `!harmony link …`, after a reply's quote too. It may hold a code, so no bridge relays it. */
export function isRoomCommand(body: unknown): boolean {
  return typeof body === 'string' && COMMAND.test(withoutQuote(body))
}

/** The code of `!harmony link <code>`; '' when there is none. */
export function roomCode(body: string): string {
  const match = /^!harmony\s+link\s+(\S{1,64})$/i.exec(withoutQuote(body).trim())
  return match ? match[1].toUpperCase() : ''
}
