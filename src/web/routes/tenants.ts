import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireAuth, requireAuthApi, generateCsrf, verifyCsrf } from '../middleware/auth.js'
import { sendPage } from '../server.js'
import { isAccountDbReady } from '../../db/account.js'
import { getAllGroups } from '../../db/queries/groups.js'
import {
  listTenants, getTenant, createTenant, renameTenant, deleteTenant, getTenantEntries,
  setTenantGroups, loadMembershipSnapshot, getTenantCoveredGroupJids, TenantConflictError,
} from '../../db/queries/tenants.js'
import {
  listTriggers, getTrigger, createTrigger, updateTrigger, setTriggerEnabled, deleteTrigger, reorderTriggers,
} from '../../db/queries/triggers.js'
import { otherTenantClaim, shadowedGroups, tenantOfGroup } from '../../tenants/membership.js'
import { getTriggerType, listTriggerTypes } from '../../triggers/registry.js'
import { registerBuiltinTriggerTypes } from '../../triggers/index.js'

const NAME_MAX = 100
const ENABLED_ERROR = 'The enabled value must be true or false'

type AnyBody = Record<string, unknown>

/** Common checks for write routes: CSRF, then account DB. Returns true when the reply was sent. */
function rejectWrite(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!verifyCsrf(req)) { reply.status(403).send({ error: 'Invalid CSRF token' }); return true }
  return rejectNotReady(reply)
}

function rejectNotReady(reply: FastifyReply): boolean {
  if (!isAccountDbReady()) { reply.status(503).send({ error: 'Not connected' }); return true }
  return false
}

function parseId(value: unknown): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name.length >= 1 && name.length <= NAME_MAX ? name : null
}

function bodyOf(req: FastifyRequest): AnyBody {
  const b = req.body
  return typeof b === 'object' && b !== null && !Array.isArray(b) ? b as AnyBody : {}
}

function typeInfo(type: NonNullable<ReturnType<typeof getTriggerType>>) {
  return {
    id: type.id,
    displayName: type.displayName,
    defaults: type.defaults(),
    defaultPrompt: type.defaultPrompt,
    defaultErrorTemplate: type.defaultErrorTemplate,
  }
}

export function registerTenantRoutes(app: FastifyInstance) {
  registerBuiltinTriggerTypes()

  const nameMap = () => new Map(getAllGroups().map(g => [g.jid, g.name]))
  /** The tenant's groups for the Q&A group select: sorted by name, with the bot's membership. */
  const coveredGroupRows = (jids: string[]) => {
    const byJid = new Map(getAllGroups().map(g => [g.jid, g]))
    return jids
      .map(jid => ({ jid, name: byJid.get(jid)?.name ?? jid, botMembership: byJid.get(jid)?.botMembership ?? 'none' }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  function entryRows(tenantId: number, names: Map<string, string>) {
    const { groups } = loadMembershipSnapshot()
    return getTenantEntries(tenantId).map(jid => {
      const g = groups.get(jid)
      const isCommunity = g?.isCommunity ?? false
      let groupCount = 1
      if (isCommunity) {
        groupCount = [...groups.values()].filter(x => x.parentCommunityJid === jid && !x.isCommunity).length
      }
      return { jid, name: names.get(jid) ?? jid, isCommunity, groupCount }
    })
  }

  app.get('/tenants', { preHandler: requireAuth }, async (req, reply) => {
    generateCsrf(req)
    return sendPage(reply, 'tenants.html', req)
  })

  app.get('/tenants/:id', { preHandler: requireAuth }, async (req, reply) => {
    generateCsrf(req)
    return sendPage(reply, 'tenant.html', req)
  })

  // 'new' is a fixed segment, so it wins over :triggerId
  app.get('/tenants/:id/triggers/new', { preHandler: requireAuth }, async (req, reply) => {
    generateCsrf(req)
    return sendPage(reply, 'trigger.html', req)
  })

  app.get('/tenants/:id/triggers/:triggerId', { preHandler: requireAuth }, async (req, reply) => {
    generateCsrf(req)
    return sendPage(reply, 'trigger.html', req)
  })

  app.get('/api/tenants', { preHandler: requireAuthApi }, async (_req, reply) => {
    if (rejectNotReady(reply)) return
    const names = nameMap()
    return reply.send({
      tenants: listTenants().map(t => ({
        id: t.id,
        name: t.name,
        entries: entryRows(t.id, names),
        triggers: listTriggers(t.id).map(tr => ({ id: tr.id, name: tr.name, type: tr.type })),
      })),
    })
  })

  app.post('/api/tenants', { preHandler: requireAuthApi }, async (req, reply) => {
    if (rejectWrite(req, reply)) return
    const name = cleanName(bodyOf(req).name)
    if (!name) return reply.status(400).send({ error: `The name must be 1 to ${NAME_MAX} characters` })
    return reply.send({ id: createTenant(name) })
  })

  app.get('/api/tenants/:id', { preHandler: requireAuthApi }, async (req, reply) => {
    if (rejectNotReady(reply)) return
    const id = parseId((req.params as { id: string }).id)
    const tenant = id === null ? null : getTenant(id)
    if (!tenant) return reply.status(404).send({ error: 'Tenant not found' })
    const names = nameMap()
    const snapshot = loadMembershipSnapshot()
    const tenantNames = new Map(listTenants().map(t => [t.id, t.name]))
    const covered = getTenantCoveredGroupJids(tenant.id)
    const warnings = shadowedGroups(tenant.id, snapshot.entries, snapshot.groups).map(jid => {
      const owner = tenantOfGroup(jid, snapshot.entries, snapshot.groups)
      return `${names.get(jid) ?? jid} is in tenant ${owner === null ? '?' : tenantNames.get(owner) ?? '?'} directly, so it is not part of this tenant`
    })
    // The other side: this tenant's own groups whose community is in another tenant
    for (const jid of getTenantEntries(tenant.id)) {
      const claim = otherTenantClaim(jid, tenant.id, snapshot.entries, snapshot.groups)
      if (!claim?.communityJid) continue
      const community = names.get(claim.communityJid) ?? claim.communityJid
      warnings.push(`${names.get(jid) ?? jid} is also in community ${community} of tenant ${tenantNames.get(claim.tenantId) ?? '?'}`)
    }
    const groupName = (jid: string) => names.get(jid) ?? jid
    const triggers = listTriggers(tenant.id).map(tr => {
      const type = getTriggerType(tr.type)
      if (!type) {
        return { id: tr.id, name: tr.name, type: tr.type, typeName: tr.type, enabled: tr.enabled, summary: '', warning: 'This trigger type is unknown' }
      }
      const config = type.normalize(tr.config)
      return {
        id: tr.id, name: tr.name, type: tr.type, typeName: type.displayName, enabled: tr.enabled,
        summary: type.summarize(config, groupName), warning: type.warning(config, covered),
      }
    })
    return reply.send({
      tenant,
      entries: entryRows(tenant.id, names),
      coveredGroups: coveredGroupRows(covered),
      warnings,
      triggers,
      triggerTypes: listTriggerTypes().map(t => ({ id: t.id, displayName: t.displayName })),
    })
  })

  app.put('/api/tenants/:id', { preHandler: requireAuthApi }, async (req, reply) => {
    if (rejectWrite(req, reply)) return
    const id = parseId((req.params as { id: string }).id)
    if (id === null || !getTenant(id)) return reply.status(404).send({ error: 'Tenant not found' })
    const name = cleanName(bodyOf(req).name)
    if (!name) return reply.status(400).send({ error: `The name must be 1 to ${NAME_MAX} characters` })
    renameTenant(id, name)
    return reply.send({ ok: true })
  })

  app.delete('/api/tenants/:id', { preHandler: requireAuthApi }, async (req, reply) => {
    if (rejectWrite(req, reply)) return
    const id = parseId((req.params as { id: string }).id)
    if (id === null || !getTenant(id)) return reply.status(404).send({ error: 'Tenant not found' })
    deleteTenant(id)
    return reply.send({ ok: true })
  })

  app.put('/api/tenants/:id/groups', { preHandler: requireAuthApi }, async (req, reply) => {
    if (rejectWrite(req, reply)) return
    const id = parseId((req.params as { id: string }).id)
    if (id === null || !getTenant(id)) return reply.status(404).send({ error: 'Tenant not found' })
    const { jids } = bodyOf(req)
    if (!Array.isArray(jids) || !jids.every(j => typeof j === 'string')) {
      return reply.status(400).send({ error: 'jids must be a list of group ids' })
    }
    try {
      setTenantGroups(id, jids as string[])
    } catch (err) {
      if (err instanceof TenantConflictError) {
        const names = nameMap()
        const snapshot = loadMembershipSnapshot()
        const tenantNames = new Map(listTenants().map(t => [t.id, t.name]))
        return reply.status(409).send({
          error: 'Some groups already belong to another tenant',
          // Name the other tenant, and the community when the group comes to it through one
          conflicts: err.conflicts.map(jid => {
            const claim = otherTenantClaim(jid, id, snapshot.entries, snapshot.groups)
            return {
              jid,
              name: names.get(jid) ?? jid,
              tenantName: claim ? tenantNames.get(claim.tenantId) ?? '' : '',
              communityName: claim?.communityJid ? names.get(claim.communityJid) ?? claim.communityJid : null,
            }
          }),
        })
      }
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Could not save the groups' })
    }
    return reply.send({ ok: true })
  })

  app.put('/api/tenants/:id/trigger-order', { preHandler: requireAuthApi }, async (req, reply) => {
    if (rejectWrite(req, reply)) return
    const id = parseId((req.params as { id: string }).id)
    if (id === null || !getTenant(id)) return reply.status(404).send({ error: 'Tenant not found' })
    const { ids } = bodyOf(req)
    if (!Array.isArray(ids) || !ids.every(i => typeof i === 'number')) {
      return reply.status(400).send({ error: 'ids must be a list of trigger ids' })
    }
    try {
      reorderTriggers(id, ids as number[])
    } catch {
      return reply.status(400).send({ error: 'The list must contain exactly this tenant\'s triggers' })
    }
    return reply.send({ ok: true })
  })

  app.post('/api/tenants/:id/triggers', { preHandler: requireAuthApi }, async (req, reply) => {
    if (rejectWrite(req, reply)) return
    const id = parseId((req.params as { id: string }).id)
    if (id === null || !getTenant(id)) return reply.status(404).send({ error: 'Tenant not found' })
    const body = bodyOf(req)
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return reply.status(400).send({ error: ENABLED_ERROR })
    const type = typeof body.type === 'string' ? getTriggerType(body.type) : null
    if (!type) return reply.status(400).send({ error: 'Unknown trigger type' })
    const name = cleanName(body.name)
    if (!name) return reply.status(400).send({ error: `The name must be 1 to ${NAME_MAX} characters` })
    const result = type.validate(body.config, { coveredGroupJids: getTenantCoveredGroupJids(id) })
    if (!result.ok) return reply.status(400).send({ error: result.error })
    const triggerId = createTrigger({
      tenantId: id, type: type.id, name, enabled: body.enabled ?? true,
      config: result.config as unknown as Record<string, unknown>,
    })
    return reply.send({ id: triggerId })
  })

  app.get('/api/triggers/:id', { preHandler: requireAuthApi }, async (req, reply) => {
    if (rejectNotReady(reply)) return
    const id = parseId((req.params as { id: string }).id)
    const trigger = id === null ? null : getTrigger(id)
    const tenant = trigger ? getTenant(trigger.tenantId) : null
    const type = trigger ? getTriggerType(trigger.type) : null
    if (!trigger || !tenant || !type) return reply.status(404).send({ error: 'Trigger not found' })
    const config = type.normalize(trigger.config)
    const names = nameMap()
    // Names of the groups the settings point to, also of one that is no longer in the tenant
    const settingsGroups = Object.values(config).filter((v): v is string => typeof v === 'string' && names.has(v))
    return reply.send({
      trigger: {
        id: trigger.id, tenantId: trigger.tenantId, type: trigger.type, name: trigger.name,
        enabled: trigger.enabled, config,
      },
      tenant: { id: tenant.id, name: tenant.name },
      coveredGroups: coveredGroupRows(getTenantCoveredGroupJids(tenant.id)),
      groupNames: Object.fromEntries(settingsGroups.map(jid => [jid, names.get(jid)])),
      type: typeInfo(type),
    })
  })

  app.get('/api/trigger-types/:type', { preHandler: requireAuthApi }, async (req, reply) => {
    if (rejectNotReady(reply)) return
    const type = getTriggerType((req.params as { type: string }).type)
    if (!type) return reply.status(404).send({ error: 'Unknown trigger type' })
    const tenantId = parseId((req.query as { tenant?: string }).tenant)
    if (tenantId === null || !getTenant(tenantId)) return reply.status(404).send({ error: 'Tenant not found' })
    return reply.send({
      type: typeInfo(type),
      coveredGroups: coveredGroupRows(getTenantCoveredGroupJids(tenantId)),
    })
  })

  app.put('/api/triggers/:id', { preHandler: requireAuthApi }, async (req, reply) => {
    if (rejectWrite(req, reply)) return
    const id = parseId((req.params as { id: string }).id)
    const trigger = id === null ? null : getTrigger(id)
    const type = trigger ? getTriggerType(trigger.type) : null
    if (!trigger || !type) return reply.status(404).send({ error: 'Trigger not found' })
    const body = bodyOf(req)
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return reply.status(400).send({ error: ENABLED_ERROR })
    const name = cleanName(body.name)
    if (!name) return reply.status(400).send({ error: `The name must be 1 to ${NAME_MAX} characters` })
    const result = type.validate(body.config, { coveredGroupJids: getTenantCoveredGroupJids(trigger.tenantId) })
    if (!result.ok) return reply.status(400).send({ error: result.error })
    updateTrigger(trigger.id, {
      name, enabled: body.enabled ?? trigger.enabled, config: result.config as unknown as Record<string, unknown>,
    })
    return reply.send({ ok: true })
  })

  app.patch('/api/triggers/:id/enabled', { preHandler: requireAuthApi }, async (req, reply) => {
    if (rejectWrite(req, reply)) return
    const id = parseId((req.params as { id: string }).id)
    if (id === null || !getTrigger(id)) return reply.status(404).send({ error: 'Trigger not found' })
    const { enabled } = bodyOf(req)
    if (typeof enabled !== 'boolean') return reply.status(400).send({ error: ENABLED_ERROR })
    setTriggerEnabled(id, enabled)
    return reply.send({ ok: true })
  })

  app.delete('/api/triggers/:id', { preHandler: requireAuthApi }, async (req, reply) => {
    if (rejectWrite(req, reply)) return
    const id = parseId((req.params as { id: string }).id)
    if (id === null || !getTrigger(id)) return reply.status(404).send({ error: 'Trigger not found' })
    deleteTrigger(id)
    return reply.send({ ok: true })
  })
}
