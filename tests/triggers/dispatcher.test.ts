import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedTenant } from '../helpers/fixtures.js'
import { updateBotUser, handleConnectionUpdate } from '../../src/whatsapp/handlers/connection.js'
import { registerSentMessage } from '../../src/bot/sent-registry.js'
import { createTrigger, setTriggerEnabled } from '../../src/db/queries/triggers.js'
import { getJob } from '../../src/db/queries/jobs.js'
import { dispatchEvent } from '../../src/triggers/dispatcher.js'
import { registerTriggerType, clearTriggerTypesForTests } from '../../src/triggers/registry.js'
import { TriggerType, type BaseTriggerConfig, type TriggerEvent } from '../../src/triggers/types.js'

const NOW_MS = 1_800_000_000_000
const NOW_S = NOW_MS / 1000

interface TestConfig extends BaseTriggerConfig { match: boolean }

class TestType extends TriggerType<TestConfig> {
  readonly id = 'test'
  readonly displayName = 'Test'
  readonly eventKind = 'group_message' as const
  readonly jobType = 'test_job'
  readonly conditions = [{ id: 'match', check: (_e: TriggerEvent, c: TestConfig) => c.match }]
  defaults(): TestConfig {
    return { onlyIfFirst: false, waitSeconds: 0, maxAgeMinutes: 60, errorTemplate: '', match: true }
  }
  validate(raw: unknown) { return { ok: true as const, config: this.normalize(raw as Record<string, unknown>) } }
  watches() { return true }
  buildJob(event: TriggerEvent) {
    const r = event.record
    return { groupJid: r.groupJid, userJid: r.userJid, messageId: r.messageId, payload: {} }
  }
}

let dbs: ReturnType<typeof setupTestDbs>
let tenantId: number
beforeEach(() => {
  dbs = setupTestDbs()
  updateBotUser({ id: '15550001234@s.whatsapp.net', lid: '98765432101234@lid' } as never)
  clearTriggerTypesForTests()
  registerTriggerType(new TestType())
  seedGroup('g@g.us', 'G')
  seedGroup('free@g.us', 'Free')
  tenantId = seedTenant('T', ['g@g.us'])
})
afterEach(() => { dbs.cleanup() })

function record(over: Record<string, unknown> = {}) {
  return {
    groupJid: 'g@g.us', userJid: 'u@s.whatsapp.net', messageId: `M${Math.random()}`,
    parentId: null, eventType: 'message', metadata: null, timestamp: NOW_S - 5, ...over,
  } as never
}
const ev = (r: never): TriggerEvent => ({ kind: 'group_message', record: r })
const cfg = (over: Record<string, unknown> = {}) => ({ ...new TestType().defaults(), ...over })
const add = (over: Record<string, unknown> = {}, type = 'test') =>
  createTrigger({ tenantId, type, name: 'x', config: cfg(over) })

describe('dispatchEvent', () => {
  it('creates one job per matching trigger, in sort order, with trigger id, run_at and expires_at', () => {
    const t1 = add({ waitSeconds: 10 })
    const t2 = add()
    const r = record()
    const ids = dispatchEvent(ev(r), NOW_MS)
    expect(ids).toHaveLength(2)
    const j1 = getJob(ids[0])!
    expect(j1.triggerId).toBe(t1)
    expect(j1.jobType).toBe('test_job')
    expect(j1.runAt).toBe(NOW_S + 10)
    expect(j1.expiresAt).toBe(NOW_S - 5 + 3600)
    expect(getJob(ids[1])!.triggerId).toBe(t2)
  })

  it('does nothing for groups in no tenant, disabled triggers, bot messages, unknown types', () => {
    const t = add()
    expect(dispatchEvent(ev(record({ groupJid: 'free@g.us' })), NOW_MS)).toEqual([])
    setTriggerEnabled(t, false)
    expect(dispatchEvent(ev(record()), NOW_MS)).toEqual([])
    setTriggerEnabled(t, true)
    registerSentMessage('BOTMSG')
    expect(dispatchEvent(ev(record({ messageId: 'BOTMSG' })), NOW_MS)).toEqual([])
    add({}, 'nope')
    expect(dispatchEvent(ev(record()), NOW_MS)).toHaveLength(1)
  })

  it('does nothing when the bot identity is unknown', () => {
    add()
    handleConnectionUpdate({ connection: 'open' }, null)
    expect(dispatchEvent(ev(record()), NOW_MS)).toEqual([])
  })

  it('does not fire when a condition fails', () => {
    add({ match: false })
    expect(dispatchEvent(ev(record()), NOW_MS)).toEqual([])
  })

  it('ignores events older than maxAgeMinutes', () => {
    add({ maxAgeMinutes: 1 })
    expect(dispatchEvent(ev(record({ timestamp: NOW_S - 61 })), NOW_MS)).toEqual([])
    expect(dispatchEvent(ev(record({ timestamp: NOW_S - 59 })), NOW_MS)).toHaveLength(1)
  })

  it('skips an onlyIfFirst trigger when an earlier one fired, not when the earlier one did not match', () => {
    const first = add()
    add({ onlyIfFirst: true })
    expect(dispatchEvent(ev(record()), NOW_MS)).toHaveLength(1)
    setTriggerEnabled(first, false)
    const second = add({ match: false })
    expect(second).toBeGreaterThan(0)
    expect(dispatchEvent(ev(record()), NOW_MS)).toHaveLength(1)
  })

  it('treats a redelivered message as fired without creating a second job', () => {
    add()
    const t2 = add()
    const r = record()
    expect(dispatchEvent(ev(r), NOW_MS)).toHaveLength(2)
    expect(dispatchEvent(ev(r), NOW_MS)).toEqual([])
    // trigger 2 set to onlyIfFirst: redelivery still creates nothing for it
    // (trigger 1's duplicate insert counts as fired)
    setTriggerEnabled(t2, false)
    const t3 = add({ onlyIfFirst: true })
    expect(t3).toBeGreaterThan(0)
    expect(dispatchEvent(ev(r), NOW_MS)).toEqual([])
  })
})
