import type { WASocket, BaileysEventMap } from 'baileys'
import { logger } from '../../utils/logger.js'
import { upsertGroupFromMetadata, updateBotMembership } from '../../db/queries/groups.js'
import { upsertUser } from '../../db/queries/users.js'
import { upsertMembership, membershipFromAdmin, syncGroupParticipants } from '../../db/queries/members.js'
import { isAccountDbReady } from '../../db/account.js'

type ParticipantsUpdate = BaileysEventMap['group-participants.update']

function bareJid(jid: string): string {
  return jid.split(':')[0].split('@')[0]
}

export async function handleGroupParticipantsUpdate(event: ParticipantsUpdate, sock: WASocket) {
  if (!isAccountDbReady()) return
  const { id: groupJid, participants, action } = event
  const actor = (event as { author?: string }).author || null
  const eventOpts = { source: 'event' as const, actor }
  const botJid = sock.user?.id
  if (!botJid) return

  const botPhone = bareJid(botJid)
  const botLidBare = sock.user?.lid ? bareJid(sock.user.lid) : null

  for (const p of participants) {
    const pid = bareJid(p.id)
    const isBotAffected = pid === botPhone || (botLidBare && pid === botLidBare)

    upsertUser(p.id, {
      phoneNumber: p.phoneNumber || undefined,
      displayName: p.notify || undefined,
    })

    if (action === 'add') {
      if (isBotAffected) {
        logger.info({ groupJid }, 'Bot added to group')
        try {
          const meta = await sock.groupMetadata(groupJid)
          upsertGroupFromMetadata(meta, botJid, sock.user?.lid)
          syncGroupParticipants(meta.id, meta.participants)
          logger.info({ groupJid, name: meta.subject }, 'Group and participants synced')
        } catch (err) {
          logger.error({ groupJid, err }, 'Failed to sync group after bot was added')
        }
      } else {
        upsertMembership(groupJid, p.id, membershipFromAdmin(p.admin), eventOpts)
        logger.debug({ groupJid, participant: p.id }, 'Participant added')
      }
    } else if (action === 'remove') {
      if (isBotAffected) {
        logger.info({ groupJid }, 'Bot removed from group')
        updateBotMembership(groupJid, 'none')
      } else {
        upsertMembership(groupJid, p.id, 'none', eventOpts)
        logger.debug({ groupJid, participant: p.id }, 'Participant removed')
      }
    } else if (action === 'promote') {
      if (isBotAffected) {
        logger.info({ groupJid }, 'Bot promoted in group')
        updateBotMembership(groupJid, 'admin')
      } else {
        upsertMembership(groupJid, p.id, 'admin', eventOpts)
        logger.debug({ groupJid, participant: p.id }, 'Participant promoted')
      }
    } else if (action === 'demote') {
      if (isBotAffected) {
        logger.info({ groupJid }, 'Bot demoted in group')
        updateBotMembership(groupJid, 'participant')
      } else {
        upsertMembership(groupJid, p.id, 'participant', eventOpts)
        logger.debug({ groupJid, participant: p.id }, 'Participant demoted')
      }
    }
  }
}
