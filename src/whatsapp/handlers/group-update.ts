import type { WASocket, GroupMetadata, BaileysEventMap } from 'baileys'
import { logger } from '../../utils/logger.js'
import { upsertGroupFromMetadata } from '../../db/queries/groups.js'
import { syncGroupParticipants } from '../../db/queries/members.js'
import { isAccountDbReady } from '../../db/account.js'

/** groups.update fires on metadata changes (rename, settings, community linking).
 *  A genuine change event carries only the changed fields — upserting that
 *  partial would clobber the other columns, so we re-fetch the full metadata.
 *  But groupFetchAllParticipating (startup sync, resync) also emits this event
 *  with FULL metadata for every group: answering that with one RPC per group
 *  would be an N-request storm, so full payloads are upserted directly. */
export async function handleGroupsUpdate(updates: BaileysEventMap['groups.update'], sock: WASocket) {
  if (!isAccountDbReady()) return
  const botJid = sock.user?.id
  if (!botJid) return

  for (const update of updates) {
    if (!update.id) continue
    try {
      const isFull = update.subject !== undefined && Array.isArray((update as Partial<GroupMetadata>).participants)
      const meta = isFull ? update as GroupMetadata : await sock.groupMetadata(update.id)
      upsertGroupFromMetadata(meta, botJid, sock.user?.lid)
      syncGroupParticipants(meta.id, meta.participants)
      logger.info({ groupJid: update.id, name: meta.subject, fetched: !isFull }, 'Group metadata refreshed')
    } catch (err) {
      logger.warn({ groupJid: update.id, err }, 'Failed to refresh group metadata after update')
    }
  }
}
