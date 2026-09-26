import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { WASocket } from 'baileys'
import { setupTestDbs } from '../helpers/db.js'
import { syncGroups } from '../../src/whatsapp/handlers/group-sync.js'
import { getGroup } from '../../src/db/queries/groups.js'

let dbs: ReturnType<typeof setupTestDbs>
beforeEach(() => { dbs = setupTestDbs() })
afterEach(() => { dbs.cleanup() })

const BOT_ID = '15550001234:1@s.whatsapp.net'

describe('syncGroups', () => {
  it('returns true on success and stores the groups', async () => {
    const sock = {
      user: { id: BOT_ID },
      groupFetchAllParticipating: async () => ({
        'g1@g.us': { id: 'g1@g.us', subject: 'Synced', participants: [{ id: BOT_ID }] },
      }),
    } as unknown as WASocket
    await expect(syncGroups(sock)).resolves.toBe(true)
    expect(getGroup('g1@g.us')!.name).toBe('Synced')
  })

  it('returns false when the fetch fails', async () => {
    const sock = {
      user: { id: BOT_ID },
      groupFetchAllParticipating: async () => { throw new Error('socket down') },
    } as unknown as WASocket
    await expect(syncGroups(sock)).resolves.toBe(false)
  })
})
