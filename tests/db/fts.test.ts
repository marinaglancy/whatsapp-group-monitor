import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { setupTestDbs, TEST_PHONE } from '../helpers/db.js'
import { seedGroup, seedUser, seedMessage } from '../helpers/fixtures.js'
import { getAccountDb, closeAccountDb, initAccountDb } from '../../src/db/account.js'

let dbs: ReturnType<typeof setupTestDbs>
beforeEach(() => {
  dbs = setupTestDbs()
  seedGroup('g1@g.us', 'G1')
  seedUser('u1@lid')
})
afterEach(() => { dbs.cleanup() })

function ftsRowids(match: string): number[] {
  const rows = getAccountDb().all(sql`SELECT rowid AS id FROM messages_fts WHERE messages_fts MATCH ${match}`) as { id: number }[]
  return rows.map(r => r.id)
}

describe('messages_fts', () => {
  it('exists and indexes new text messages via the trigger', () => {
    seedMessage('g1@g.us', 'u1@lid', 'peanut butter jelly time', 100)
    expect(ftsRowids('jelly').length).toBe(1)
  })

  it('applies porter stemming', () => {
    seedMessage('g1@g.us', 'u1@lid', 'we were discussing the picnic yesterday', 100)
    expect(ftsRowids('discuss').length).toBe(1)
    expect(ftsRowids('picnics').length).toBe(1)
  })

  it('indexes edit rows but not media-only or reaction rows', () => {
    seedMessage('g1@g.us', 'u1@lid', 'original text', 100, { messageId: 'M1' })
    seedMessage('g1@g.us', 'u1@lid', '', 101, { eventType: 'edit', parentId: 'M1', metadata: { contentType: 'conversation', text: 'edited banana text' } })
    seedMessage('g1@g.us', 'u1@lid', '', 102, { eventType: 'reaction', parentId: 'M1', metadata: { emoji: '👍' } })
    seedMessage('g1@g.us', 'u1@lid', '', 103, { metadata: { contentType: 'imageMessage' } })
    expect(ftsRowids('banana').length).toBe(1)
    expect(ftsRowids('original').length).toBe(1)
  })

  it('backfills existing rows when the index is created on a legacy db', () => {
    seedMessage('g1@g.us', 'u1@lid', 'legacy searchable content', 100)
    const db = getAccountDb()
    db.run(sql`DROP TRIGGER trg_fts_activity`)
    db.run(sql`DROP TABLE messages_fts`)
    closeAccountDb()
    initAccountDb(TEST_PHONE) // re-runs migrations: recreate + backfill
    expect(ftsRowids('legacy').length).toBe(1)
  })
})
