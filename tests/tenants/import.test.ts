import { describe, it, expect, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from '../../src/config.js'
import { initAccountDb, closeAccountDb, getAccountDb } from '../../src/db/account.js'
import { initSharedDb } from '../../src/db/shared.js'
import { setSetting } from '../../src/db/queries/settings.js'
import { listTenants, getTenantEntries } from '../../src/db/queries/tenants.js'
import { listTriggers } from '../../src/db/queries/triggers.js'
import { logger } from '../../src/utils/logger.js'
import { OLD_GROUPS_DDL } from '../helpers/backup.js'

const PHONE = '15550000009'
let dir = ''

interface G { jid: string; name: string; fn?: number; cfg?: object | null; at?: number; parent?: string; comm?: number }

/** A pre-tenant account.db: groups with bot_config and the old bot_jobs, no tenant tables. */
function makeLegacyDb(groups: G[]) {
  dir = mkdtempSync(join(tmpdir(), 'wgm-import-'))
  config.dataDir = dir
  mkdirSync(join(dir, PHONE), { recursive: true })
  const raw = new Database(join(dir, PHONE, 'account.db'))
  raw.exec(OLD_GROUPS_DDL.replace('created_at INTEGER NOT NULL)', 'created_at INTEGER NOT NULL, bot_config TEXT)'))
  raw.exec(`CREATE TABLE bot_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, job_type TEXT NOT NULL, group_jid TEXT,
    user_jid TEXT, message_id TEXT, payload TEXT, status TEXT NOT NULL DEFAULT 'pending', run_at INTEGER NOT NULL,
    expires_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, ai_calls INTEGER NOT NULL DEFAULT 0,
    ai_tokens_in INTEGER NOT NULL DEFAULT 0, ai_tokens_out INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
  const ins = raw.prepare(`INSERT INTO groups (jid, name, is_community, parent_community_jid, bot_functions, created_at, bot_config)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
  for (const g of groups) {
    ins.run(g.jid, g.name, g.comm ?? 0, g.parent ?? null, g.fn ?? 0, g.at ?? 1000, g.cfg ? JSON.stringify(g.cfg) : null)
  }
  raw.close()
  initSharedDb()
}

afterEach(() => {
  closeAccountDb()
  vi.restoreAllMocks()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('converting legacy Q&A groups', () => {
  it('turns each Q&A group into a tenant with its linked groups and a Q&A trigger', () => {
    makeLegacyDb([
      { jid: 'qa@g.us', name: 'Ask here', fn: 1, cfg: { qa: { linkedJids: ['a@g.us', 'qa@g.us'], instructions: 'Be brief' } } },
      { jid: 'a@g.us', name: 'A' },
      { jid: 'plain@g.us', name: 'Plain' },
    ])
    initAccountDb(PHONE)
    const tenants = listTenants()
    expect(tenants.map(t => t.name)).toEqual(['Ask here'])
    expect(getTenantEntries(tenants[0].id).sort()).toEqual(['a@g.us', 'qa@g.us'])
    const triggers = listTriggers(tenants[0].id)
    expect(triggers).toHaveLength(1)
    expect(triggers[0]).toMatchObject({ type: 'qa', name: 'Q&A', enabled: true, sortOrder: 1 })
    expect(triggers[0].config).toMatchObject({ qaGroupJid: 'qa@g.us', instructions: 'Be brief', prompt: '' })
  })

  it('copies a customized Settings prompt and leaves an unchanged one empty', () => {
    makeLegacyDb([{ jid: 'qa@g.us', name: 'Q', fn: 1 }])
    setSetting('ai_system_prompt', 'My own prompt')
    initAccountDb(PHONE)
    expect(listTriggers(listTenants()[0].id)[0].config).toMatchObject({ prompt: 'My own prompt' })
  })

  it('leaves the prompt empty when Settings has none', () => {
    makeLegacyDb([{ jid: 'qa@g.us', name: 'Q', fn: 1 }])
    initAccountDb(PHONE)
    expect(listTriggers(listTenants()[0].id)[0].config).toMatchObject({ prompt: '' })
  })

  it('creates a disabled trigger for a group whose Q&A bit is off', () => {
    makeLegacyDb([{ jid: 'qa@g.us', name: 'Q', fn: 0, cfg: { qa: { instructions: 'x' } } }])
    initAccountDb(PHONE)
    const t = listTenants()[0]
    expect(listTriggers(t.id)[0].enabled).toBe(false)
    expect(getTenantEntries(t.id)).toEqual(['qa@g.us'])
  })

  it('skips a group already taken by an earlier tenant and logs a warning', () => {
    makeLegacyDb([
      { jid: 'one@g.us', name: 'One', fn: 1, at: 1, cfg: { qa: { linkedJids: ['shared@g.us'] } } },
      { jid: 'two@g.us', name: 'Two', fn: 1, at: 2, cfg: { qa: { linkedJids: ['shared@g.us'] } } },
    ])
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    initAccountDb(PHONE)
    const byName = Object.fromEntries(listTenants().map(t => [t.name, getTenantEntries(t.id).sort()]))
    expect(byName).toEqual({ One: ['one@g.us', 'shared@g.us'], Two: ['two@g.us'] })
    expect(warn).toHaveBeenCalledWith({ jid: 'shared@g.us', tenant: 'Two' }, expect.any(String))
  })

  it('keeps the tenant and its Q&A trigger even when all its groups are taken', () => {
    makeLegacyDb([
      { jid: 'a@g.us', name: 'A', fn: 1, at: 1, cfg: { qa: { linkedJids: ['b@g.us'] } } },
      { jid: 'b@g.us', name: 'B', fn: 1, at: 2, cfg: { qa: { instructions: 'Keep me' } } },
    ])
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    initAccountDb(PHONE)
    const b = listTenants().find(t => t.name === 'B')!
    expect(getTenantEntries(b.id)).toEqual([])
    expect(listTriggers(b.id)[0]).toMatchObject({ type: 'qa', enabled: true })
    expect(listTriggers(b.id)[0].config).toMatchObject({ qaGroupJid: 'b@g.us', instructions: 'Keep me' })
  })

  it('tolerates malformed old settings instead of failing', () => {
    makeLegacyDb([
      { jid: 'a@g.us', name: 'A', fn: 1, at: 1, cfg: { qa: { linkedJids: [{}, 'ok@g.us', ''], instructions: 42 } } },
      { jid: 'b@g.us', name: 'B', fn: 1, at: 2, cfg: { qa: { linkedJids: 'nope' } } },
      { jid: 'c@g.us', name: 'C', fn: 1, at: 3, cfg: 5 },
      { jid: 'd@g.us', name: 'D', fn: 1, at: 4, cfg: [] },
    ])
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    expect(() => initAccountDb(PHONE)).not.toThrow()
    const byName = Object.fromEntries(listTenants().map(t => [t.name, t]))
    expect(Object.keys(byName).sort()).toEqual(['A', 'B', 'C', 'D'])
    expect(getTenantEntries(byName.A.id).sort()).toEqual(['a@g.us', 'ok@g.us'])
    expect(listTriggers(byName.A.id)[0].config).toMatchObject({ instructions: '' })
    expect(getTenantEntries(byName.B.id)).toEqual(['b@g.us'])
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ jid: 'a@g.us' }), expect.any(String))
    expect(warn).toHaveBeenCalledWith({ jid: 'c@g.us' }, expect.any(String))
  })

  it('rolls back the tenant tables when the conversion really fails, and retries on the next open', () => {
    makeLegacyDb([{ jid: 'qa@g.us', name: 'Q', fn: 1 }])
    // a leftover table of the wrong shape makes the trigger insert fail
    const raw = new Database(join(dir, PHONE, 'account.db'))
    raw.exec('CREATE TABLE bot_triggers (id INTEGER PRIMARY KEY)')
    raw.close()
    expect(() => initAccountDb(PHONE)).toThrow()
    const check = new Database(join(dir, PHONE, 'account.db'))
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name='tenants'").get()).toBeUndefined()
    check.exec('DROP TABLE bot_triggers')
    check.close()
    initAccountDb(PHONE)
    expect(listTenants().map(t => t.name)).toEqual(['Q'])
  })

  it('runs only once: a deleted tenant is not re-created on the next open', () => {
    makeLegacyDb([{ jid: 'qa@g.us', name: 'Q', fn: 1 }])
    initAccountDb(PHONE)
    getAccountDb().$client.exec('DELETE FROM bot_triggers; DELETE FROM tenant_groups; DELETE FROM tenants')
    closeAccountDb()
    initAccountDb(PHONE)
    expect(listTenants()).toEqual([])
  })

  it('creates nothing on a fresh install', () => {
    dir = mkdtempSync(join(tmpdir(), 'wgm-import-'))
    config.dataDir = dir
    initSharedDb()
    initAccountDb(PHONE)
    expect(listTenants()).toEqual([])
  })
})
