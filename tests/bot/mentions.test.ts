import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedUser } from '../helpers/fixtures.js'
import { resolveMentionTokens, expandGroupMentionTokens } from '../../src/bot/setup.js'

let dbs: ReturnType<typeof setupTestDbs>
beforeEach(() => {
  dbs = setupTestDbs()
  seedGroup('120363000000000001@g.us', 'Alpha')
  seedUser('88112233445@lid', 'Zoe', '4917699887766')
})
afterEach(() => { dbs.cleanup() })

describe('resolveMentionTokens', () => {
  it('resolves group jid digits to group mentions', () => {
    const out = resolveMentionTokens('See @120363000000000001 for details.')
    expect(out.groupMentions).toEqual([{ groupJid: '120363000000000001@g.us', groupSubject: 'Alpha' }])
    expect(out.mentions).toEqual([])
  })

  it('resolves member lid digits and phone digits to user mentions', () => {
    const out = resolveMentionTokens('Top poster: @88112233445, also reachable as @4917699887766.')
    expect(out.mentions).toEqual(['88112233445@lid'])
    expect(out.groupMentions).toEqual([])
  })

  it('leaves unknown tokens unresolved and dedupes repeats', () => {
    const out = resolveMentionTokens('@88112233445 and @88112233445 and @55555 again')
    expect(out.mentions).toEqual(['88112233445@lid'])
    expect(out.groupMentions).toEqual([])
  })

  it('ignores short digit runs and plain text', () => {
    const out = resolveMentionTokens('meet @9am, nothing else')
    expect(out.mentions).toEqual([])
    expect(out.groupMentions).toEqual([])
  })
})

describe('expandGroupMentionTokens', () => {
  const gm = [{ groupJid: '120363000000000001@g.us', groupSubject: 'Alpha' }]

  it('rewrites group tokens to the full-jid form real clients use', () => {
    expect(expandGroupMentionTokens('in @120363000000000001: *5*, and again @120363000000000001.', gm))
      .toBe('in @120363000000000001@g.us: *5*, and again @120363000000000001@g.us.')
  })

  it('is idempotent on already-full tokens and leaves other digits alone', () => {
    expect(expandGroupMentionTokens('see @120363000000000001@g.us and @88112233445', gm))
      .toBe('see @120363000000000001@g.us and @88112233445')
  })
})
