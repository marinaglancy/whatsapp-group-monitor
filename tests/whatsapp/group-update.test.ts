import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { WASocket } from 'baileys'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup } from '../helpers/fixtures.js'
import { updateGroupQaConfig, getGroup } from '../../src/db/queries/groups.js'
import { getGroupMembers } from '../../src/db/queries/members.js'
import { handleGroupsUpdate } from '../../src/whatsapp/handlers/group-update.js'

const BOT_ID = '15550001234:1@s.whatsapp.net'

function fakeSock(metaByJid: Record<string, unknown>): WASocket {
  return {
    user: { id: BOT_ID, lid: '98765432101234:2@lid' },
    groupMetadata: async (jid: string) => {
      const meta = metaByJid[jid]
      if (!meta) throw new Error('not found')
      return meta
    },
  } as unknown as WASocket
}

let dbs: ReturnType<typeof setupTestDbs>
beforeEach(() => {
  dbs = setupTestDbs()
  seedGroup('g1@g.us', 'Old Name', { botFunctions: 1, botConfig: { qa: { linkedJids: ['g2@g.us'], instructions: 'Hi' } } })
})
afterEach(() => { dbs.cleanup() })

describe('handleGroupsUpdate', () => {
  it('refreshes name, permissions, membership and participants, preserving bot config', async () => {
    const sock = fakeSock({
      'g1@g.us': {
        id: 'g1@g.us',
        subject: 'New Name',
        announce: true,
        restrict: false,
        memberAddMode: false,
        joinApprovalMode: true,
        participants: [
          { id: BOT_ID, admin: 'admin' },
          { id: 'member@lid' },
        ],
      },
    })
    await handleGroupsUpdate([{ id: 'g1@g.us', subject: 'New Name' }], sock)

    const g = getGroup('g1@g.us')!
    expect(g.name).toBe('New Name')
    expect(g.permissions).toMatchObject({ announce: true, joinApprovalMode: true })
    expect(g.botMembership).toBe('admin')
    // qa config untouched by the metadata refresh
    expect(g.qaEnabled).toBe(true)
    expect(g.qaLinkedJids).toEqual(['g2@g.us'])
    expect(g.qaInstructions).toBe('Hi')
    // participants synced from the fetched metadata
    expect(getGroupMembers('g1@g.us').map(m => m.userJid)).toContain('member@lid')
  })

  it('upserts directly from a full-metadata event without fetching (sync echo)', async () => {
    // groupFetchAllParticipating emits groups.update with FULL metadata for every
    // group; the handler must not answer that with one RPC per group
    const sock = fakeSock({}) // any groupMetadata call would throw 'not found'
    await handleGroupsUpdate([{
      id: 'g1@g.us',
      subject: 'Renamed Via Event',
      announce: true,
      participants: [{ id: BOT_ID, admin: 'admin' }, { id: 'member@lid' }],
    } as never], sock)
    const g = getGroup('g1@g.us')!
    expect(g.name).toBe('Renamed Via Event')
    expect(g.botMembership).toBe('admin')
    expect(g.qaEnabled).toBe(true) // config still preserved
    expect(getGroupMembers('g1@g.us').map(m => m.userJid)).toContain('member@lid')
  })

  it('logs and continues when metadata cannot be fetched', async () => {
    const sock = fakeSock({})
    await expect(handleGroupsUpdate([{ id: 'g1@g.us', subject: 'X' }], sock)).resolves.toBeUndefined()
    expect(getGroup('g1@g.us')!.name).toBe('Old Name')
  })

  it('ignores entries without an id', async () => {
    const sock = fakeSock({})
    await expect(handleGroupsUpdate([{ subject: 'X' }], sock)).resolves.toBeUndefined()
  })
})
