import { and, asc, eq, sql } from 'drizzle-orm'
import { getAccountDb } from '../account.js'
import { botTriggers, type BotTrigger } from '../schema.js'

export function listTriggers(tenantId: number): BotTrigger[] {
  return getAccountDb().select().from(botTriggers)
    .where(eq(botTriggers.tenantId, tenantId))
    .orderBy(asc(botTriggers.sortOrder), asc(botTriggers.id)).all()
}

export function listEnabledTriggers(tenantId: number): BotTrigger[] {
  return getAccountDb().select().from(botTriggers)
    .where(and(eq(botTriggers.tenantId, tenantId), eq(botTriggers.enabled, true)))
    .orderBy(asc(botTriggers.sortOrder), asc(botTriggers.id)).all()
}

export function getTrigger(id: number): BotTrigger | null {
  return getAccountDb().select().from(botTriggers).where(eq(botTriggers.id, id)).get() ?? null
}

export function createTrigger(p: {
  tenantId: number; type: string; name: string; enabled?: boolean; config: Record<string, unknown>
}): number {
  const db = getAccountDb()
  return db.transaction(tx => {
    const max = tx.select({ m: sql<number>`COALESCE(MAX(${botTriggers.sortOrder}), 0)` })
      .from(botTriggers).where(eq(botTriggers.tenantId, p.tenantId)).get()
    return tx.insert(botTriggers).values({
      tenantId: p.tenantId,
      type: p.type,
      name: p.name,
      enabled: p.enabled ?? true,
      sortOrder: (max?.m ?? 0) + 1,
      config: p.config,
    }).returning({ id: botTriggers.id }).get().id
  })
}

export function updateTrigger(id: number, p: { name?: string; enabled?: boolean; config?: Record<string, unknown> }): void {
  const set: Partial<typeof botTriggers.$inferInsert> = { updatedAt: new Date() }
  if (p.name !== undefined) set.name = p.name
  if (p.enabled !== undefined) set.enabled = p.enabled
  if (p.config !== undefined) set.config = p.config
  getAccountDb().update(botTriggers).set(set).where(eq(botTriggers.id, id)).run()
}

export function setTriggerEnabled(id: number, enabled: boolean): void {
  updateTrigger(id, { enabled })
}

export function deleteTrigger(id: number): void {
  getAccountDb().delete(botTriggers).where(eq(botTriggers.id, id)).run()
}

/** orderedIds must be exactly the tenant's trigger ids (each once), else throws. */
export function reorderTriggers(tenantId: number, orderedIds: number[]): void {
  getAccountDb().transaction(tx => {
    const current = tx.select({ id: botTriggers.id }).from(botTriggers)
      .where(eq(botTriggers.tenantId, tenantId)).all().map(r => r.id)
    const same = orderedIds.length === current.length
      && new Set(orderedIds).size === orderedIds.length
      && orderedIds.every(id => current.includes(id))
    if (!same) throw new Error('reorderTriggers: ids must be exactly the tenant\'s triggers')
    orderedIds.forEach((id, i) => {
      tx.update(botTriggers).set({ sortOrder: i + 1, updatedAt: new Date() })
        .where(eq(botTriggers.id, id)).run()
    })
  })
}
