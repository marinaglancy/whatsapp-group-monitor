/** The text used to tell whether two messages are "the same": trimmed, whitespace collapsed. */
export function normalizeText(t: string): string {
  return t.trim().replace(/\s+/g, ' ')
}

/** `123@lid` -> `@123`; `120363@g.us` -> `@120363` (the sender turns these into tappable mentions). */
function mention(jid: string): string {
  return '@' + jid.split('@')[0]
}

function groupSection(title: string, groups: string[]): string | null {
  if (groups.length === 0) return null
  return [title, ...groups.map(g => `- group ${mention(g)}`)].join('\n')
}

function join(blocks: (string | null)[]): string {
  return blocks.filter((b): b is string => b !== null).join('\n\n')
}

export function spammerReport(s: {
  userJid: string; contents: string; notDeleted: string[]; deleted: string[]; removal?: string
}): string {
  return join([
    `Detected spam by user ${mention(s.userJid)}:`,
    groupSection('*Not deleted!*', s.notDeleted),
    groupSection('*Deleted messages:*', s.deleted),
    s.removal ? s.removal : null,
    `*Deleted message contents:*\n${s.contents}`,
  ])
}

export function suspiciousReport(s: {
  userJid: string; contents: string; notDeleted: string[]; deleted: string[]
}): string {
  return join([
    `Suspicious message by user ${mention(s.userJid)}`,
    groupSection('*Not deleted:*', s.notDeleted),
    groupSection('*Deleted:*', s.deleted),
    s.contents,
  ])
}
