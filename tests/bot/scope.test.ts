import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedTenant } from '../helpers/fixtures.js'
import { updateGroupQaConfig, getGroup } from '../../src/db/queries/groups.js'
import { resolveTenantScope } from '../../src/bot/scope.js'
import { getAccountDb } from '../../src/db/account.js'
import { BOT_FUNCTION_QA, groups } from '../../src/db/schema.js'

let dbs: ReturnType<typeof setupTestDbs>
beforeEach(() => {
  dbs = setupTestDbs()
  seedGroup('qa@g.us', 'Admins')
  seedGroup('comm@g.us', 'Active Hive', { isCommunity: true })
  seedGroup('a@g.us', 'Alpha', { parentCommunityJid: 'comm@g.us' })
  seedGroup('b@g.us', 'Beta', { parentCommunityJid: 'comm@g.us' })
  seedGroup('solo@g.us', 'Solo Group')
})
afterEach(() => { dbs.cleanup() })

describe('updateGroupQaConfig', () => {
  it('sets and clears the QA bit and stores linked jids', () => {
    updateGroupQaConfig('qa@g.us', { enabled: true, linkedJids: ['comm@g.us'] })
    let g = getGroup('qa@g.us')!
    expect(g.qaEnabled).toBe(true)
    expect(g.qaLinkedJids).toEqual(['comm@g.us'])
    expect(g.botFunctions & BOT_FUNCTION_QA).toBe(BOT_FUNCTION_QA)

    updateGroupQaConfig('qa@g.us', { enabled: false, linkedJids: [] })
    g = getGroup('qa@g.us')!
    expect(g.qaEnabled).toBe(false)
    expect(g.qaLinkedJids).toEqual([])
  })

  it('stores instructions and preserves foreign bot_config namespaces', () => {
    // simulate a future function's config already present
    getAccountDb().update(groups)
      .set({ botConfig: { spam: { note: 'keep me' } } })
      .where(eq(groups.jid, 'qa@g.us')).run()
    updateGroupQaConfig('qa@g.us', { enabled: true, linkedJids: ['solo@g.us'], instructions: 'Be terse.' })
    const g = getGroup('qa@g.us')!
    expect(g.qaInstructions).toBe('Be terse.')
    expect(g.botConfig).toEqual({ spam: { note: 'keep me' }, qa: { linkedJids: ['solo@g.us'], instructions: 'Be terse.' } })
    // blank instructions remove the key
    updateGroupQaConfig('qa@g.us', { enabled: true, linkedJids: ['solo@g.us'], instructions: null })
    expect(getGroup('qa@g.us')!.qaInstructions).toBeNull()
  })

  it('appears in toJSON', () => {
    updateGroupQaConfig('qa@g.us', { enabled: true, linkedJids: ['solo@g.us'], instructions: 'Hi.' })
    const json = getGroup('qa@g.us')!.toJSON() as Record<string, unknown>
    expect(json.qaEnabled).toBe(true)
    expect(json.qaLinkedJids).toEqual(['solo@g.us'])
    expect(json.qaInstructions).toBe('Hi.')
  })
})

describe('resolveTenantScope', () => {
  it('expands a community to its current children', () => {
    const t = seedTenant('T', ['qa@g.us', 'comm@g.us'])
    const scope = resolveTenantScope(t, 'qa@g.us')
    expect(scope.groupJids.sort()).toEqual(['a@g.us', 'b@g.us', 'qa@g.us'])
    const comm = scope.entries.find(e => e.isCommunity)!
    expect(comm.children.map(c => c.name).sort()).toEqual(['Alpha', 'Beta'])
    expect(scope.names.get('a@g.us')).toBe('Alpha')
  })

  it('always includes the asking group, first and marked, even when not in the tenant', () => {
    const t = seedTenant('T', ['solo@g.us'])
    const scope = resolveTenantScope(t, 'qa@g.us')
    expect(scope.groupJids).toEqual(['qa@g.us', 'solo@g.us'])
    expect(scope.entries[0]).toMatchObject({ jid: 'qa@g.us', isSelf: true })
    expect(scope.entries.filter(e => e.isSelf).length).toBe(1)
  })

  it('does not duplicate the asking group when it is also an entry', () => {
    const t = seedTenant('T', ['qa@g.us', 'solo@g.us'])
    const scope = resolveTenantScope(t, 'qa@g.us')
    expect(scope.groupJids).toEqual(['qa@g.us', 'solo@g.us'])
    expect(scope.entries.filter(e => e.jid === 'qa@g.us').length).toBe(1)
  })

  it('dedupes overlap between a community and an explicit child', () => {
    const t = seedTenant('T', ['comm@g.us', 'a@g.us', 'solo@g.us'])
    const scope = resolveTenantScope(t, 'qa@g.us')
    expect(scope.groupJids.sort()).toEqual(['a@g.us', 'b@g.us', 'qa@g.us', 'solo@g.us'])
  })

  it('silently drops vanished jids and keeps communities with no children', () => {
    seedGroup('empty-comm@g.us', 'Empty Community', { isCommunity: true })
    seedGroup('gone@g.us', 'Gone')
    const t = seedTenant('T', ['gone@g.us', 'empty-comm@g.us'])
    getAccountDb().delete(groups).where(eq(groups.jid, 'gone@g.us')).run()
    const scope = resolveTenantScope(t, 'qa@g.us')
    expect(scope.groupJids).toEqual(['qa@g.us'])
    expect(scope.entries.length).toBe(2)
  })

  it('returns self-only for an empty tenant and nothing for an unknown asking group', () => {
    const t = seedTenant('T', [])
    expect(resolveTenantScope(t, 'qa@g.us').groupJids).toEqual(['qa@g.us'])
    expect(resolveTenantScope(t, 'nope@g.us').groupJids).toEqual([])
  })

  it('drops groups the bot has left from scope', () => {
    seedGroup('left@g.us', 'Left Group', { botMembership: 'none' })
    seedGroup('c@g.us', 'Gamma', { parentCommunityJid: 'comm@g.us', botMembership: 'none' })
    const t = seedTenant('T', ['left@g.us', 'comm@g.us'])
    const scope = resolveTenantScope(t, 'qa@g.us')
    expect(scope.groupJids.sort()).toEqual(['a@g.us', 'b@g.us', 'qa@g.us'])
    expect(scope.entries.find(e => e.jid === 'left@g.us')).toBeUndefined()
    const comm = scope.entries.find(e => e.jid === 'comm@g.us')!
    expect(comm.children.map(c => c.name).sort()).toEqual(['Alpha', 'Beta'])
  })

  it('puts a group added to the community later in scope without touching the tenant', () => {
    const t = seedTenant('T', ['comm@g.us'])
    expect(resolveTenantScope(t, 'qa@g.us').groupJids).not.toContain('new@g.us')
    seedGroup('new@g.us', 'Newcomer', { parentCommunityJid: 'comm@g.us' })
    expect(resolveTenantScope(t, 'qa@g.us').groupJids).toContain('new@g.us')
  })
})
