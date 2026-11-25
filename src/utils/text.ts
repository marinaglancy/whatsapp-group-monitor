/** The text used to tell whether two messages are "the same": trimmed, whitespace collapsed. */
export function normalizeText(t: string): string {
  return t.trim().replace(/\s+/g, ' ')
}

/** A jid without its device and server parts: `123:4@s.whatsapp.net` -> `123`,
 *  `120363@g.us` -> `120363`. */
export function bareId(jid: string): string {
  return jid.split(':')[0].split('@')[0]
}
