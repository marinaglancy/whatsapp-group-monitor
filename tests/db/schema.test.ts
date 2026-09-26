import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { setupTestDbs } from '../helpers/db.js'
import { getAccountDb } from '../../src/db/account.js'

let dbs: ReturnType<typeof setupTestDbs>
beforeEach(() => { dbs = setupTestDbs() })
afterEach(() => { dbs.cleanup() })

function tableNames(): string[] {
  const rows = getAccountDb().all(sql`SELECT name FROM sqlite_master WHERE type='table'`) as { name: string }[]
  return rows.map(r => r.name)
}

describe('account db schema', () => {
  it('creates the existing core tables', () => {
    const names = tableNames()
    expect(names).toContain('groups')
    expect(names).toContain('group_activity_log')
  })
})
