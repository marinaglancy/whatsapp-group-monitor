import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedUser } from '../helpers/fixtures.js'
import { insertActivity } from '../../src/db/queries/activity.js'
import { ActivityRecord } from '../../src/whatsapp/activity/record.js'

let dbs: ReturnType<typeof setupTestDbs>
beforeEach(() => {
  dbs = setupTestDbs()
  seedGroup('g1@g.us', 'G1')
  seedUser('u1@lid')
})
afterEach(() => { dbs.cleanup() })

describe('insertActivity', () => {
  it('returns false on duplicate (group, message) instead of throwing', () => {
    const row = {
      id: 1, groupJid: 'g1@g.us', userJid: 'u1@lid', messageId: 'M1', parentId: null,
      eventType: 'message' as const, metadata: { text: 'hi' }, raw: null, timestamp: 1, createdAt: new Date(),
    }
    const rec = ActivityRecord.fromDbRow(row)
    expect(insertActivity(rec)).toBe(true)
    expect(insertActivity(rec)).toBe(false) // offline catch-up replays rely on this
  })
})
