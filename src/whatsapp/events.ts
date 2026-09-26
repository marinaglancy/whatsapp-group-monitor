import type { WASocket } from 'baileys'
import { handleConnectionUpdate, updateBotUser } from './handlers/connection.js'
import { syncGroups } from './handlers/group-sync.js'
import { handleMessagesUpsert } from './handlers/activity.js'
import { handleMessagesReaction } from './handlers/activity-reactions.js'
import { handleContactsUpsert, handleContactsUpdate } from './handlers/contacts.js'
import { handleMessageReceiptUpdate } from './handlers/receipts.js'
import { handleGroupsUpsert } from './handlers/group-join.js'
import { handleGroupsUpdate } from './handlers/group-update.js'
import { handleGroupParticipantsUpdate } from './handlers/group-participants.js'
import { handleGroupJoinRequest } from './handlers/group-join-request.js'
import { logger } from '../utils/logger.js'

export function setupEventHandlers(sock: WASocket, saveCreds: () => Promise<void>) {
  sock.ev.process(async (events) => {
    if (events['connection.update']) {
      handleConnectionUpdate(events['connection.update'], sock.user)

      if (events['connection.update'].connection === 'open') {
        syncGroups(sock)
      }
    }

    if (events['creds.update']) {
      await saveCreds()
      updateBotUser(events['creds.update'].me)
      logger.debug('Credentials saved')
    }

    if (events['messages.upsert']) {
      handleMessagesUpsert(events['messages.upsert'])
    }

    if (events['messages.reaction']) {
      handleMessagesReaction(events['messages.reaction'])
    }

    if (events['contacts.upsert']) {
      handleContactsUpsert(events['contacts.upsert'])
    }

    if (events['contacts.update']) {
      handleContactsUpdate(events['contacts.update'])
    }

    if (events['message-receipt.update']) {
      handleMessageReceiptUpdate(events['message-receipt.update'])
    }

    if (events['groups.upsert']) {
      handleGroupsUpsert(events['groups.upsert'], sock)
    }

    if (events['groups.update']) {
      handleGroupsUpdate(events['groups.update'], sock)
    }

    if (events['group-participants.update']) {
      handleGroupParticipantsUpdate(events['group-participants.update'], sock)
    }

    if (events['group.join-request']) {
      handleGroupJoinRequest(events['group.join-request'], sock)
    }
  })
}
