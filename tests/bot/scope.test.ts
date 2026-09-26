import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup } from '../helpers/fixtures.js'
import { updateGroupQaConfig, getGroup } from '../../src/db/queries/groups.js'
import { resolveQaScope } from '../../src/bot/scope.js'
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

describe('resolveQaScope', () => {
  it('expands a community to its current children', () => {
    updateGroupQaConfig('qa@g.us', { enabled: true, linkedJids: ['comm@g.us'] })
    const scope = resolveQaScope('qa@g.us')
    expect(scope.groupJids.sort()).toEqual(['a@g.us', 'b@g.us'])
    expect(scope.entries[0].isCommunity).toBe(true)
    expect(scope.entries[0].children.map(c => c.name).sort()).toEqual(['Alpha', 'Beta'])
    expect(scope.names.get('a@g.us')).toBe('Alpha')
  })

  it('dedupes overlap between a community and an explicitly linked child', () => {
    updateGroupQaConfig('qa@g.us', { enabled: true, linkedJids: ['comm@g.us', 'a@g.us', 'solo@g.us'] })
    const scope = resolveQaScope('qa@g.us')
    expect(scope.groupJids.sort()).toEqual(['a@g.us', 'b@g.us', 'solo@g.us'])
  })

  it('silently drops vanished jids and communities with no children', () => {
    seedGroup('empty-comm@g.us', 'Empty Community', { isCommunity: true })
    updateGroupQaConfig('qa@g.us', { enabled: true, linkedJids: ['gone@g.us', 'empty-comm@g.us'] })
    const scope = resolveQaScope('qa@g.us')
    expect(scope.groupJids).toEqual([])
    expect(scope.entries.length).toBe(1) // the empty community is listed, the vanished jid is not
  })

  it('includes the QA group itself only when explicitly linked', () => {
    updateGroupQaConfig('qa@g.us', { enabled: true, linkedJids: ['qa@g.us'] })
    expect(resolveQaScope('qa@g.us').groupJids).toEqual(['qa@g.us'])
    updateGroupQaConfig('qa@g.us', { enabled: true, linkedJids: ['solo@g.us'] })
    expect(resolveQaScope('qa@g.us').groupJids).toEqual(['solo@g.us'])
  })

  it('returns an empty scope for unknown or unconfigured groups', () => {
    expect(resolveQaScope('qa@g.us').groupJids).toEqual([])
    expect(resolveQaScope('nope@g.us').groupJids).toEqual([])
  })

  it('carries the QA group instructions', () => {
    updateGroupQaConfig('qa@g.us', { enabled: true, linkedJids: ['solo@g.us'], instructions: 'Be terse.' })
    expect(resolveQaScope('qa@g.us').qaInstructions).toBe('Be terse.')
    expect(resolveQaScope('solo@g.us').qaInstructions).toBeNull()
  })
})
