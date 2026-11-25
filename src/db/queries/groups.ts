import { eq, notInArray } from 'drizzle-orm'
import type { GroupMetadata, GroupParticipant } from 'baileys'
import { getAccountDb } from '../account.js'
import { groups, type Group } from '../schema.js'
import { GroupRecord } from '../../whatsapp/group/record.js'

function bareId(jid: string): string {
  return jid.split(':')[0].split('@')[0]
}

function botMembershipFromParticipant(p: GroupParticipant | undefined): Group['botMembership'] {
  if (!p) return 'none'
  if (p.admin === 'superadmin') return 'superadmin'
  if (p.admin === 'admin') return 'admin'
  return 'participant'
}

export function upsertGroupFromMetadata(meta: GroupMetadata, botJid: string, botLid?: string) {
  const db = getAccountDb()
  const botPhone = bareId(botJid)
  const botLidBare = botLid ? bareId(botLid) : null
  const botParticipant = meta.participants.find(p => {
    const pid = bareId(p.id)
    return pid === botPhone || (botLidBare && pid === botLidBare)
  })

  const values = {
    jid: meta.id,
    name: meta.subject,
    description: meta.desc ?? null,
    isCommunity: meta.isCommunity ?? false,
    parentCommunityJid: meta.linkedParent ?? null,
    permissions: {
      announce: meta.announce ?? false,
      restrict: meta.restrict ?? false,
      memberAddMode: meta.memberAddMode ?? false,
      joinApprovalMode: meta.joinApprovalMode ?? false,
    },
    botMembership: botMembershipFromParticipant(botParticipant),
    syncedAt: new Date(),
  }

  return db.insert(groups).values({
    ...values,
    createdAt: new Date(),
  }).onConflictDoUpdate({
    target: groups.jid,
    set: values,
  }).run()
}

export function getAllGroups(): GroupRecord[] {
  const db = getAccountDb()
  const records = db.select().from(groups).all().map(r => new GroupRecord(r))
  GroupRecord.linkAll(records)
  return records
}

export function getGroup(jid: string): GroupRecord | null {
  return getAllGroups().find(g => g.jid === jid) ?? null
}

export function updateBotMembership(groupJid: string, membership: Group['botMembership']) {
  const db = getAccountDb()
  return db.update(groups).set({ botMembership: membership }).where(eq(groups.jid, groupJid)).run()
}

export function markAbsentGroupsAsNone(activeJids: string[]) {
  const db = getAccountDb()
  if (activeJids.length === 0) {
    return db.update(groups).set({ botMembership: 'none' }).run()
  }
  return db.update(groups)
    .set({ botMembership: 'none' })
    .where(notInArray(groups.jid, activeJids))
    .run()
}
