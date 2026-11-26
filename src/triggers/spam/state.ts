import type { SpamCaseState } from '../../db/schema.js'

export function unique(items: string[]): string[] {
  return [...new Set(items)]
}

/** The report's lists after this job (ruling R15): what is done wins, so a
 *  group whose copy a later job deleted moves from "not deleted" to
 *  "deleted", a group the user was removed from leaves "could not remove",
 *  and a community removal that succeeded once stays "removed". */
export function mergeState(earlier: SpamCaseState | null, fresh: SpamCaseState): SpamCaseState {
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
  if (community) state.community = community
  return state
}

function sameSet(a: string[], b: string[]): boolean {
  const set = new Set(a)
  return set.size === new Set(b).size && b.every(x => set.has(x))
}

/** Whether two report states list the same things (order does not matter). */
export function sameState(a: SpamCaseState, b: SpamCaseState): boolean {
  return sameSet(a.notDeleted, b.notDeleted) && sameSet(a.deleted, b.deleted)
    && sameSet(a.removedFrom, b.removedFrom) && sameSet(a.notRemovedFrom, b.notRemovedFrom)
    && a.community === b.community
}
