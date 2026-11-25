/** The text used to tell whether two messages are "the same": trimmed, whitespace collapsed. */
export function normalizeText(t: string): string {
  return t.trim().replace(/\s+/g, ' ')
}

/** A jid without its device and server parts: `123:4@s.whatsapp.net` -> `123`,
 *  `120363@g.us` -> `120363`. */
export function bareId(jid: string): string {
  return jid.split(':')[0].split('@')[0]
}

/** The text on one line: every line break becomes a space. */
export function singleLine(t: string): string {
  return t.replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, ' ')
}

/** How much of a text the pattern checks read: enough for any real message,
 *  and a very long text cannot make them slow. */
export const TEXT_SCAN_MAX = 4_000

const LINK_RE = /https?:\/\/|\bwww\.[a-z0-9]|\b(?:[a-z0-9-]{1,63}\.){1,10}[a-z]{2,24}\//i

/** Whether the text has a web link: http(s)://, www., or a domain followed by a slash. */
export function hasLink(text: string): boolean {
  return LINK_RE.test(text.slice(0, TEXT_SCAN_MAX))
}
