// History sync: when a device is linked, the phone sends a copy of the chat history.
// - Group messages carry the sender in the top-level `participant`, not in key.participant
//   (checked on a real sync, 2026-11-02)
// - Each message also carries its reactions, poll votes and event RSVPs: the latest
//   one per person, each with its own key and send time. Votes and RSVPs come
//   already decrypted.
// - Records are only saved, never processed: history must not trigger Q&A answers
// - The `history_import` setting decides how far back: 'gaps' (default) saves only
//   activity from the group's first recorded activity onwards, 'all' saves everything
// - Poll/event keys (messageSecret) sit on the outer message in history, not in
//   message.messageContextInfo where fromMessage reads them
// - The bot never asks for more history (fetchMessageHistory), so it only arrives
//   when a device is linked

import { jidNormalizedUser } from 'baileys'
import type { BaileysEventMap, WAMessage, proto } from 'baileys'
import { isAccountDbReady } from '../../db/account.js'
import { getGroup } from '../../db/queries/groups.js'
import { getGroupFirstActivity, hasReactionSince } from '../../db/queries/activity.js'
import { getSettingOrDefault } from '../../db/queries/settings.js'
import { ActivityRecord, ownJid } from '../activity/record.js'
import { logger } from '../../utils/logger.js'

export const HISTORY_IMPORT_MODES = ['gaps', 'all'] as const
export type HistoryImportMode = typeof HISTORY_IMPORT_MODES[number]

// A live reaction is stored when it arrives, never before it was sent, so it can only
// look older than the history copy when the sender's phone clock runs ahead
const CLOCK_SLACK_S = 60

type InRange = (groupJid: string, timestamp: number) => boolean

function newCounts() {
  return {
    groupMessages: 0, saved: 0, duplicates: 0,
    skippedGroup: 0, skippedOld: 0, skippedSender: 0, skippedNoTime: 0,
    reactions: 0, reactionsSaved: 0, reactionsAlreadyRecorded: 0,
    pollUpdates: 0, votesSaved: 0, votesAlreadyRecorded: 0,
    eventResponses: 0, eventResponsesSaved: 0, eventResponsesAlreadyRecorded: 0,
  }
}
type Counts = ReturnType<typeof newCounts>

export function getHistoryImportMode(): HistoryImportMode {
  return getSettingOrDefault('history_import', 'gaps') === 'all' ? 'all' : 'gaps'
}

export function handleHistorySync(event: BaileysEventMap['messaging-history.set']) {
  if (!isAccountDbReady()) {
    // Baileys never resends a history chunk, so a dropped one is gone for good
    logger.warn({ syncType: event.syncType, messages: event.messages.length }, 'History sync dropped: account database not open')
    return
  }
  const fillGapsOnly = getHistoryImportMode() === 'gaps'

  const knownGroups = new Map<string, boolean>()
  // Looked up before anything is saved in the group; saving never moves it,
  // since only activity at or after it is saved
  const firstActivity = new Map<string, number | null>()
  const inRange: InRange = (groupJid, timestamp) => {
    if (!fillGapsOnly) return true
    if (!firstActivity.has(groupJid)) firstActivity.set(groupJid, getGroupFirstActivity(groupJid))
    const first = firstActivity.get(groupJid)
    return first != null && timestamp >= first
  }
  const counts = newCounts()

  for (const msg of event.messages) {
    const groupJid = msg.key.remoteJid
    if (!groupJid?.endsWith('@g.us')) continue
    counts.groupMessages++

    if (!knownGroups.has(groupJid)) knownGroups.set(groupJid, getGroup(groupJid) !== null)
    if (!knownGroups.get(groupJid)) { counts.skippedGroup++; continue }

    // Reactions, votes and RSVPs have their own time, so they are imported even
    // when the message itself is skipped
    const outcome = importMessage(msg, groupJid, inRange)
    if (outcome) counts[outcome]++
    importReactions(msg, groupJid, inRange, counts)
    importVotes(msg, groupJid, inRange, counts)
    importEventResponses(msg, groupJid, inRange, counts)
  }

  logger.info({ syncType: event.syncType, progress: event.progress, ...counts }, 'History sync saved')
}

/** Saves the message itself; returns the count it adds to */
function importMessage(msg: WAMessage, groupJid: string, inRange: InRange): keyof Counts | null {
  const timestamp = Number(msg.messageTimestamp || 0)
  if (!timestamp) return 'skippedNoTime'
  if (!inRange(groupJid, timestamp)) return 'skippedOld'

  // Own messages resolve to the bot account inside fromMessage (both key ids
  // cleared, or it would take the phone id). Others must be a lid, like every
  // live record, so one person is not stored under two ids.
  const sender = msg.key.fromMe ? undefined : (msg.key.participant || msg.participant || undefined)
  if (!msg.key.fromMe && !sender?.endsWith('@lid')) return 'skippedSender'

  const secret = msg.messageSecret
  const message = secret && msg.message && !msg.message.messageContextInfo?.messageSecret
    ? { ...msg.message, messageContextInfo: { ...msg.message.messageContextInfo, messageSecret: secret } }
    : msg.message
  const record = ActivityRecord.fromMessage(
    { ...msg, message, key: { ...msg.key, participant: sender, participantAlt: undefined } },
    groupJid,
  )
  if (!record) return null

  return record.save() ? 'saved' : 'duplicates'
}

// Live reactions are stored under made-up IDs (see fromReaction), so a reaction
// already recorded live is found by person and message instead of by ID
function importReactions(msg: WAMessage, groupJid: string, inRange: InRange, counts: Counts) {
  const targetId = msg.key.id
  if (!targetId) return
  for (const reaction of msg.reactions ?? []) {
    counts.reactions++
    const userJid = historyActor(reaction.key)
    if (!userJid) continue
    const record = ActivityRecord.fromHistoryReaction(groupJid, targetId, reaction, userJid)
    if (!record || !inRange(groupJid, record.timestamp)) continue
    if (hasReactionSince(groupJid, targetId, userJid, record.timestamp - CLOCK_SLACK_S)) counts.reactionsAlreadyRecorded++
    else if (record.save()) counts.reactionsSaved++
    else counts.reactionsAlreadyRecorded++
  }
}

// A history vote has the same ID as the live one, so a vote already recorded
// live is a duplicate that save() does not insert
function importVotes(msg: WAMessage, groupJid: string, inRange: InRange, counts: Counts) {
  const pollId = msg.key.id
  if (!pollId) return
  const poll = msg.message?.pollCreationMessage || msg.message?.pollCreationMessageV2 || msg.message?.pollCreationMessageV3
  const options = (poll?.options || []).map(o => o.optionName || '')
  for (const update of msg.pollUpdates ?? []) {
    counts.pollUpdates++
    const userJid = historyActor(update.pollUpdateMessageKey)
    if (!userJid) continue
    const record = ActivityRecord.fromHistoryVote(groupJid, pollId, update, options, userJid)
    if (!record || !inRange(groupJid, record.timestamp)) continue
    if (record.save()) counts.votesSaved++
    else counts.votesAlreadyRecorded++
  }
}

// Same as votes: a history RSVP has the same ID as the live one
function importEventResponses(msg: WAMessage, groupJid: string, inRange: InRange, counts: Counts) {
  const eventId = msg.key.id
  if (!eventId) return
  for (const response of msg.eventResponses ?? []) {
    counts.eventResponses++
    const userJid = historyActor(response.eventResponseMessageKey)
    if (!userJid) continue
    const record = ActivityRecord.fromHistoryEventResponse(groupJid, eventId, response, userJid)
    if (!record || !inRange(groupJid, record.timestamp)) continue
    if (record.save()) counts.eventResponsesSaved++
    else counts.eventResponsesAlreadyRecorded++
  }
}

/** Who reacted, voted or replied: the bot account for its own, otherwise a lid like every
 *  live record (phone ids are skipped so one person is not stored under two ids) */
function historyActor(key: proto.IMessageKey | null | undefined): string | null {
  if (key?.fromMe) return ownJid()
  const jid = key?.participant ? jidNormalizedUser(key.participant) : null
  return jid?.endsWith('@lid') ? jid : null
}
