import type { SpamCaseState } from '../../db/schema.js'

export function unique(items: string[]): string[] {
  return [...new Set(items)]
}

/** The community a group belongs to, or null. */
export type CommunityOf = (groupJid: string) => string | null

/** The report's lists after this job (rulings R15, R17b): what is done wins,
 *  so a group whose copy a later job deleted moves from "not deleted" to
 *  "deleted", a group the user was removed from leaves "could not remove",
 *  and a community removal that succeeded once stays "removed". The groups of
 *  a community the user was removed from leave "could not remove" too: an
 *  earlier job may have tried them one by one. */
export function mergeState(earlier: SpamCaseState | null, fresh: SpamCaseState, communityOf: CommunityOf): SpamCaseState {
  const both = (key: 'notDeleted' | 'deleted' | 'removedFrom' | 'notRemovedFrom') =>
    unique([...(earlier?.[key] ?? []), ...fresh[key]])
  const deleted = both('deleted')
  const removedFrom = both('removedFrom')
  const state: SpamCaseState = {
    notDeleted: both('notDeleted').filter(g => !deleted.includes(g)),
    deleted,
    removedFrom,
    notRemovedFrom: both('notRemovedFrom').filter(g => !removedFrom.includes(g)),
  }
  const community = earlier?.community === 'removed' || fresh.community === 'removed'
    ? 'removed' : earlier?.community ?? fresh.community
  if (!community) return state
  state.community = community
  // the jid that goes with the status kept, the newest first (older rows have none)
  const communityJid = [fresh, earlier].find(s => s?.community === community && s.communityJid)?.communityJid
  if (communityJid) state.communityJid = communityJid
  if (community === 'removed' && communityJid) {
    state.notRemovedFrom = state.notRemovedFrom.filter(g => communityOf(g) !== communityJid)
  }
  return state
}

function sameSet(a: string[], b: string[]): boolean {
  const set = new Set(a)
  return set.size === new Set(b).size && b.every(x => set.has(x))
}

/** Whether two report states list the same things (order does not matter).
 *  The community's jid is not compared: the report does not show it. */
export function sameState(a: SpamCaseState, b: SpamCaseState): boolean {
  return sameSet(a.notDeleted, b.notDeleted) && sameSet(a.deleted, b.deleted)
    && sameSet(a.removedFrom, b.removedFrom) && sameSet(a.notRemovedFrom, b.notRemovedFrom)
    && a.community === b.community
}
