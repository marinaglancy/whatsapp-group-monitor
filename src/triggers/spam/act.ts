import type { SpamCaseState } from '../../db/schema.js'
import { getAllGroups } from '../../db/queries/groups.js'
import type { ActionResult } from '../../whatsapp/actions.js'
import type { SpamTriggerConfig } from './type.js'
import { mergeState, unique } from './state.js'

/** The WhatsApp actions a spam job can take, injected so tests can fake them. */
export interface SpamActions {
  /** Delete a member's message as an admin (deleteMemberMessage); senderJid
   *  is its author as stored on the message's activity row. */
  deleteMessage: (groupJid: string, messageId: string, senderJid: string) => Promise<ActionResult>
  /** Remove a user from a group (removeFromGroup). */
  removeFromGroup: (groupJid: string, userJid: string) => Promise<ActionResult>
  /** Remove a user from a community and so from all its groups (removeFromCommunity). */
  removeFromCommunity: (communityJid: string, userJid: string) => Promise<ActionResult>
}

/** One of the sender's messages with the checked text. */
export type Copy = { groupJid: string; messageId: string; timestamp: number }

/** An action that did not happen, kept in the job log. */
export type NotDone = { action: 'delete' | 'remove'; jid: string; reason: string; detail?: string }

/** The message the job checks, as far as acting on it goes. */
type ActMessage = { groupJid: string; userJid: string; messageId: string }

type ActConfig = Pick<SpamTriggerConfig, 'deleteSpammerCopies' | 'removeSpammer' | 'deleteSuspicious'>

interface ActInput { msg: ActMessage; copies: Copy[]; spammer: boolean; config: ActConfig }

function isAdminLevel(membership: string | null | undefined): boolean {
  return membership === 'admin' || membership === 'superadmin'
}

/** Act on a spam verdict with the actions ticked for it (spec §6.3), and
 *  return what the report lists. A spammer's copies are all deleted; for a
 *  suspicious message only this job's own one, as each copy has its own job.
 *  Deleting comes before removing. tried is false when no action is ticked. */
export async function act(
  deps: SpamActions, { msg, copies, spammer, config }: ActInput,
): Promise<{ state: SpamCaseState; notDone: NotDone[]; tried: boolean }> {
  const state: SpamCaseState = { notDeleted: [], deleted: [], removedFrom: [], notRemovedFrom: [] }
  const notDone: NotDone[] = []
  const isOwn = (c: Copy) => c.groupJid === msg.groupJid && c.messageId === msg.messageId
  const toDelete = spammer
    ? (config.deleteSpammerCopies ? copies : [])
    : (config.deleteSuspicious ? copies.filter(isOwn) : [])
  for (const c of copies) {
    const r = toDelete.includes(c) ? await deps.deleteMessage(c.groupJid, c.messageId, msg.userJid) : null
    if (r?.ok) {
      state.deleted.push(c.groupJid)
      continue
    }
    state.notDeleted.push(c.groupJid)
    if (r && !r.ok) notDone.push({ action: 'delete', jid: c.groupJid, reason: r.reason, detail: r.detail })
  }
  const removing = spammer && config.removeSpammer
  if (removing) await removeSpammer(deps, msg, copies, state, notDone)
  return { state: mergeState(null, state), notDone, tried: toDelete.length > 0 || removing }
}

/** Remove a spammer (spec §6.4): from the community of the message's group
 *  when the bot is an admin of it, and from every other group with a copy
 *  (every one of them when the community is not used). A group where the
 *  user stays (an admin there, the bot is not an admin, or WhatsApp
 *  refused) is listed as not removed. */
async function removeSpammer(
  deps: SpamActions, msg: ActMessage, copies: Copy[], state: SpamCaseState, notDone: NotDone[],
): Promise<void> {
  const groups = new Map(getAllGroups().map(g => [g.jid, g]))
  const parent = groups.get(msg.groupJid)?.parentCommunityJid ?? null
  const community = parent && isAdminLevel(groups.get(parent)?.botMembership) ? parent : null
  if (community) {
    const r = await deps.removeFromCommunity(community, msg.userJid)
    state.community = r.ok ? 'removed' : 'not_removed'
    if (!r.ok) notDone.push({ action: 'remove', jid: community, reason: r.reason, detail: r.detail })
  }
  for (const groupJid of unique(copies.map(c => c.groupJid))) {
    // the community removal covers its own groups
    if (community && groups.get(groupJid)?.parentCommunityJid === community) continue
    const r = await deps.removeFromGroup(groupJid, msg.userJid)
    if (r.ok) {
      state.removedFrom.push(groupJid)
    } else {
      state.notRemovedFrom.push(groupJid)
      notDone.push({ action: 'remove', jid: groupJid, reason: r.reason, detail: r.detail })
    }
  }
}
