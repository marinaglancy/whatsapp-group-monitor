import { bareId } from '../../utils/text.js'

export { normalizeText } from '../../utils/text.js'

/** `123@lid` -> `@123`; `120363@g.us` -> `@120363` (the sender turns these into tappable mentions). */
function mention(jid: string): string {
  return '@' + bareId(jid)
}

function groupSection(title: string, groups: string[]): string | null {
  if (groups.length === 0) return null
  return [title, ...groups.map(g => `- group ${mention(g)}`)].join('\n')
}

function join(blocks: (string | null)[]): string {
  return blocks.filter((b): b is string => b !== null).join('\n\n')
}

/** The spammer report's removal block: one line for each thing that applies. */
export function removalLines(s: { community?: 'removed' | 'not_removed'; removedFrom: string[]; notRemovedFrom: string[] }): string {
  const lines: string[] = []
  if (s.community === 'removed') lines.push('User removed from the community')
  if (s.community === 'not_removed') lines.push('User is not removed from the community')
  if (s.removedFrom.length) lines.push(`User removed from: ${s.removedFrom.map(mention).join(', ')}`)
  if (s.notRemovedFrom.length) lines.push(`Could not remove the user from: ${s.notRemovedFrom.map(mention).join(', ')}`)
  return lines.join('\n')
}

export function spammerReport(s: {
  userJid: string; contents: string; notDeleted: string[]; deleted: string[]; removal?: string
}): string {
  return join([
    `Detected spam by user ${mention(s.userJid)}:`,
    groupSection('*Not deleted!*', s.notDeleted),
    groupSection('*Deleted messages:*', s.deleted),
    s.removal ? s.removal : null,
    `*Message contents:*\n${s.contents}`,
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
