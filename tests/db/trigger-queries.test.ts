import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDbs } from '../helpers/db.js'
import { seedTenant } from '../helpers/fixtures.js'
import {
  listTriggers, listEnabledTriggers, getTrigger, createTrigger, updateTrigger,
  setTriggerEnabled, deleteTrigger, reorderTriggers,
} from '../../src/db/queries/triggers.js'

let dbs: ReturnType<typeof setupTestDbs>
beforeEach(() => { dbs = setupTestDbs() })
afterEach(() => { dbs.cleanup() })

function make(tenantId: number, name: string, enabled?: boolean) {
  return createTrigger({ tenantId, type: 'keyword', name, enabled, config: { word: name } })
}

describe('trigger queries', () => {
  it('appends new triggers at the end', () => {
    const t = seedTenant('A', [])
    const ids = [make(t, 'a'), make(t, 'b'), make(t, 'c')]
    expect(ids.map(id => getTrigger(id)!.sortOrder)).toEqual([1, 2, 3])
    expect(getTrigger(ids[0])!.config).toEqual({ word: 'a' })
    expect(getTrigger(ids[0])!.enabled).toBe(true)
    expect(getTrigger(9999)).toBeNull()
  })

  it('numbers triggers per tenant', () => {
    const t1 = seedTenant('A', [])
    const t2 = seedTenant('B', [])
    make(t1, 'a')
    expect(getTrigger(make(t2, 'x'))!.sortOrder).toBe(1)
  })

  it('reorders triggers', () => {
    const t = seedTenant('A', [])
    const [a, b, c] = [make(t, 'a'), make(t, 'b'), make(t, 'c')]
    reorderTriggers(t, [c, a, b])
    expect(listTriggers(t).map(x => x.id)).toEqual([c, a, b])
  })

  it('rejects a reorder with a missing, extra or foreign id', () => {
    const t = seedTenant('A', [])
    const other = seedTenant('B', [])
    const [a, b] = [make(t, 'a'), make(t, 'b')]
    const foreign = make(other, 'x')
    expect(() => reorderTriggers(t, [a])).toThrow()
    expect(() => reorderTriggers(t, [a, foreign])).toThrow()
    expect(() => reorderTriggers(t, [a, b, foreign])).toThrow()
    expect(() => reorderTriggers(t, [a, a])).toThrow()
    expect(listTriggers(t).map(x => x.id)).toEqual([a, b])
  })

  it('lists only enabled triggers', () => {
    const t = seedTenant('A', [])
    const a = make(t, 'a')
    make(t, 'b', false)
    const c = make(t, 'c')
    expect(listEnabledTriggers(t).map(x => x.id)).toEqual([a, c])
  })

  it('updates, toggles and deletes', () => {
    const t = seedTenant('A', [])
    const a = make(t, 'a')
    updateTrigger(a, { name: 'renamed', config: { word: 'z' } })
    expect(getTrigger(a)).toMatchObject({ name: 'renamed', config: { word: 'z' }, enabled: true })
    setTriggerEnabled(a, false)
    expect(getTrigger(a)!.enabled).toBe(false)
    updateTrigger(a, { enabled: true })
    expect(getTrigger(a)!.enabled).toBe(true)
    deleteTrigger(a)
    expect(getTrigger(a)).toBeNull()
  })
})
