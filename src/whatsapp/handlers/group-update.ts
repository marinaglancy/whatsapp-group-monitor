import type { WASocket, BaileysEventMap } from 'baileys'
import { logger } from '../../utils/logger.js'
import { upsertGroupFromMetadata } from '../../db/queries/groups.js'
import { syncGroupParticipants } from '../../db/queries/members.js'
import { isAccountDbReady } from '../../db/account.js'

/** groups.update fires on metadata changes (rename, settings, community linking).
 *  The event carries only the changed fields, so re-fetch the full metadata
 *  instead of upserting a partial that would clobber the other columns. */
export async function handleGroupsUpdate(updates: BaileysEventMap['groups.update'], sock: WASocket) {
  if (!isAccountDbReady()) return
  const botJid = sock.user?.id
  if (!botJid) return

  for (const update of updates) {
    if (!update.id) continue
    try {
      const meta = await sock.groupMetadata(update.id)
      upsertGroupFromMetadata(meta, botJid, sock.user?.lid)
      syncGroupParticipants(meta.id, meta.participants)
      logger.info({ groupJid: update.id, name: meta.subject }, 'Group metadata refreshed')
    } catch (err) {
      logger.warn({ groupJid: update.id, err }, 'Failed to refresh group metadata after update')
    }
  }
}
