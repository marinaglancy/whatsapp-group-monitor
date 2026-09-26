import { getAllGroups } from '../db/queries/groups.js'

export interface QaScopeEntry {
  jid: string
  name: string
  isCommunity: boolean
  children: { jid: string; name: string }[]
  /** The group the question was asked in — always first in scope. */
  isSelf?: boolean
}

export interface QaScope {
  entries: QaScopeEntry[]
  groupJids: string[]
  names: Map<string, string>
  qaInstructions: string | null
}

/** Resolve a QA group's linked jids into concrete group jids.
 *  Communities expand to their current children; vanished jids are dropped.
 *  The QA group itself is always in scope (first, marked isSelf) — members
 *  expect the bot to be aware of the conversation it lives in. */
export function resolveQaScope(qaGroupJid: string): QaScope {
  const all = getAllGroups() // linkAll() already applied inside
  const byJid = new Map(all.map(g => [g.jid, g]))
  const qaGroup = byJid.get(qaGroupJid)
  const linked = qaGroup?.qaLinkedJids ?? []

  const entries: QaScopeEntry[] = []
  const groupJids: string[] = []
  const names = new Map<string, string>()
  const seen = new Set<string>()

  const addGroup = (jid: string, name: string) => {
    if (seen.has(jid)) return
    seen.add(jid)
    groupJids.push(jid)
    names.set(jid, name)
  }

  if (qaGroup) {
    entries.push({ jid: qaGroup.jid, name: qaGroup.name, isCommunity: false, children: [], isSelf: true })
    addGroup(qaGroup.jid, qaGroup.name)
  }

  for (const jid of linked) {
    if (jid === qaGroupJid) continue // already present as the self entry
    const g = byJid.get(jid)
    if (!g) continue
    if (g.isCommunity) {
      // only children the bot is still a member of — data stops flowing after it leaves
      const children = g.getChildren()
        .filter(c => c.botMembership !== 'none')
        .map(c => ({ jid: c.jid, name: c.name }))
      entries.push({ jid: g.jid, name: g.name, isCommunity: true, children })
      for (const c of children) addGroup(c.jid, c.name)
    } else {
      if (g.botMembership === 'none') continue // bot left this group — drop it like a vanished jid
      entries.push({ jid: g.jid, name: g.name, isCommunity: false, children: [] })
      addGroup(g.jid, g.name)
    }
  }
  return { entries, groupJids, names, qaInstructions: qaGroup?.qaInstructions ?? null }
}
