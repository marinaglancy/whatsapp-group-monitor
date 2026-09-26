import type { FastifyInstance } from 'fastify'
import QRCode from 'qrcode'
import { config } from '../../config.js'
import { sendPage } from '../server.js'
import { getCurrentQr, getConnectionState, getBotUser } from '../../whatsapp/handlers/connection.js'
import { getSock } from '../../whatsapp/client.js'
import { requireAuth, requireAuthApi, generateCsrf, verifyCsrf } from '../middleware/auth.js'
import { getSetting, getSettingOrDefault, setSetting } from '../../db/queries/settings.js'
import { DEFAULT_GEMINI_MODEL, DEFAULT_AI_DAILY_LIMIT, getAiSettings, isValidTimezone } from '../../ai/settings.js'
import { getAllGroups, getGroup, updateGroupQaConfig, QA_INSTRUCTIONS_MAX } from '../../db/queries/groups.js'
import { GroupRecord } from '../../whatsapp/group/record.js'
import { isAccountDbReady } from '../../db/account.js'
import { jidNormalizedUser } from 'baileys'
import { getUser } from '../../db/queries/users.js'
import { listJobs, getJob, getJobEvents, listJobGroups } from '../../db/queries/jobs.js'
import { botJobStatuses, type BotJobStatus } from '../../db/schema.js'
import { getUserGroupMemberships } from '../../db/queries/members.js'
import { getUserActivityPerGroup } from '../../db/queries/activity.js'
import { registerBackupRoutes } from './backup.js'
import { syncGroups } from '../../whatsapp/handlers/group-sync.js'

export function registerRoutes(app: FastifyInstance) {
  registerBackupRoutes(app)
  // --- Public: login ---
  app.get('/login', async (req, reply) => {
    if (req.session.authenticated) {
      return reply.redirect('/')
    }
    generateCsrf(req)
    return sendPage(reply, 'login.html', req)
  })

  app.post('/login', async (req, reply) => {
    if (!verifyCsrf(req)) {
      return reply.status(403).send('Invalid CSRF token')
    }

    const { username, password } = req.body as { username?: string; password?: string }

    if (!config.adminPassword) {
      return reply.status(503).send('ADMIN_PASSWORD not configured in .env')
    }

    if (username === config.adminUsername && password === config.adminPassword) {
      req.session.authenticated = true
      return reply.redirect('/')
    }

    return reply.redirect('/login?error=1')
  })

  // --- Protected: main page ---
  app.get('/', { preHandler: requireAuth }, async (req, reply) => {
    generateCsrf(req)
    const state = getConnectionState()
    if (state === 'open') {
      return sendPage(reply, 'dashboard.html', req)
    }
    return sendPage(reply, 'connection.html', req)
  })

  app.post('/logout', { preHandler: requireAuth }, async (req, reply) => {
    if (!verifyCsrf(req)) {
      return reply.status(403).send('Invalid CSRF token')
    }
    await req.session.destroy()
    return reply.redirect('/login')
  })

  app.post('/disconnect', { preHandler: requireAuth }, async (req, reply) => {
    if (!verifyCsrf(req)) {
      return reply.status(403).send('Invalid CSRF token')
    }
    try {
      const sock = getSock()
      await sock.logout('User requested disconnect')
    } catch {
      // not connected
    }
    return reply.redirect('/')
  })

  // --- Protected: settings ---
  app.get('/settings', { preHandler: requireAuth }, async (req, reply) => {
    generateCsrf(req)
    return sendPage(reply, 'settings.html', req)
  })

  app.get('/api/settings', { preHandler: requireAuthApi }, async (_req, reply) => {
    return reply.send({
      project_name: getSettingOrDefault('project_name', 'WhatsApp Group Monitor'),
      page_size: getSettingOrDefault('page_size', '50'),
      gemini_api_key_set: !!getSetting('gemini_api_key'),
      gemini_model: getSettingOrDefault('gemini_model', DEFAULT_GEMINI_MODEL),
      ai_daily_limit: getSettingOrDefault('ai_daily_limit', String(DEFAULT_AI_DAILY_LIMIT)),
      ai_system_prompt: getAiSettings().systemPrompt,
      ai_system_prompt_is_default: !(getSetting('ai_system_prompt') || '').trim(),
      timezone: getAiSettings().timezone,
    })
  })

  app.post('/api/settings', { preHandler: requireAuthApi }, async (req, reply) => {
    if (!verifyCsrf(req)) {
      return reply.status(403).send({ error: 'Invalid CSRF token' })
    }
    const body = req.body as Record<string, string>
    // timezone is validated before anything is written
    if ('timezone' in body && typeof body.timezone === 'string') {
      const tz = body.timezone.trim()
      if (tz && !isValidTimezone(tz)) {
        return reply.status(400).send({ error: `Unknown timezone: ${tz}` })
      }
    }
    const allowed = ['project_name', 'page_size', 'gemini_model', 'ai_daily_limit', 'ai_system_prompt', 'timezone']
    for (const key of allowed) {
      if (key in body && typeof body[key] === 'string') {
        setSetting(key, body[key])
      }
    }
    // API key is write-only: non-empty replaces, empty string clears, omission keeps
    if ('gemini_api_key' in body && typeof body.gemini_api_key === 'string') {
      setSetting('gemini_api_key', body.gemini_api_key)
    }
    return reply.send({ ok: true })
  })

  // --- Protected API ---
  app.get('/api/groups', { preHandler: requireAuthApi }, async (_req, reply) => {
    if (!isAccountDbReady()) {
      return reply.send({ groups: [] })
    }
    const groups = getAllGroups()
    GroupRecord.populateAllSummaries(groups)
    return reply.send({ groups: groups.map(g => g.toJSON()) })
  })

  app.post('/api/resync', { preHandler: requireAuthApi }, async (req, reply) => {
    if (!verifyCsrf(req)) {
      return reply.status(403).send({ error: 'Invalid CSRF token' })
    }
    if (getConnectionState() !== 'open' || !isAccountDbReady()) {
      return reply.status(503).send({ error: 'Not connected' })
    }
    const ok = await syncGroups(getSock())
    if (!ok) return reply.status(502).send({ error: 'Sync failed — see server logs' })
    return reply.send({ ok: true })
  })

  app.get('/group/:jid', { preHandler: requireAuth }, async (req, reply) => {
    generateCsrf(req)
    return sendPage(reply, 'group.html', req)
  })

  app.get('/api/groups/:jid', { preHandler: requireAuthApi }, async (req, reply) => {
    if (!isAccountDbReady()) {
      return reply.status(503).send({ error: 'Not connected' })
    }
    const { jid } = req.params as { jid: string }
    const group = getGroup(jid)
    if (!group) {
      return reply.status(404).send({ error: 'Group not found' })
    }

    const members = group.getMembers({ includeLeft: true })
    const userActivity = group.getUserActivity(30)
    const activityMap = new Map(userActivity.map(a => [a.userJid, a]))

    let botUserJid: string | null = null
    try {
      const sock = getSock()
      if (sock.user?.lid) botUserJid = jidNormalizedUser(sock.user.lid)
      else if (sock.user?.id) botUserJid = jidNormalizedUser(sock.user.id)
    } catch { /* not connected */ }

    const enrichedMembers = members.map(m => {
      const activity = activityMap.get(m.userJid)
      return {
        ...m,
        isBot: botUserJid ? m.userJid === botUserJid : false,
        posts: activity?.posts ?? 0,
        reactions: activity?.reactions ?? 0,
        total: activity?.total ?? 0,
        lastActivity: activity?.lastActivity ?? null,
      }
    })

    return reply.send({
      group: {
        ...group.toJSON(),
        memberCount: group.getMemberCount(),
        lastActivity: group.getLastActivity(),
      },
      members: enrichedMembers,
    })
  })

  app.post('/api/groups/:jid/bot', { preHandler: requireAuthApi }, async (req, reply) => {
    if (!verifyCsrf(req)) {
      return reply.status(403).send({ error: 'Invalid CSRF token' })
    }
    if (!isAccountDbReady()) return reply.status(503).send({ error: 'Not connected' })
    const { jid } = req.params as { jid: string }
    const group = getGroup(jid)
    if (!group) return reply.status(404).send({ error: 'Group not found' })
    if (group.isCommunity) return reply.status(400).send({ error: 'Communities cannot be Q&A groups' })
    const body = req.body as { qaEnabled?: unknown; qaLinkedJids?: unknown; qaInstructions?: unknown }
    if (typeof body.qaEnabled !== 'boolean' || !Array.isArray(body.qaLinkedJids)
      || body.qaLinkedJids.some(j => typeof j !== 'string')) {
      return reply.status(400).send({ error: 'Invalid payload' })
    }
    if (body.qaInstructions !== undefined
      && (typeof body.qaInstructions !== 'string' || body.qaInstructions.length > QA_INSTRUCTIONS_MAX)) {
      return reply.status(400).send({ error: `Invalid instructions (max ${QA_INSTRUCTIONS_MAX} characters)` })
    }
    const linkedJids = body.qaLinkedJids as string[]
    const known = new Set(getAllGroups().map(g => g.jid))
    const unknown = linkedJids.filter(j => !known.has(j))
    if (unknown.length) return reply.status(400).send({ error: `Unknown group jids: ${unknown.join(', ')}` })
    updateGroupQaConfig(jid, {
      enabled: body.qaEnabled,
      linkedJids,
      instructions: typeof body.qaInstructions === 'string' ? body.qaInstructions : null,
    })
    return reply.send({ ok: true })
  })

  app.get('/user/:jid', { preHandler: requireAuth }, async (req, reply) => {
    generateCsrf(req)
    return sendPage(reply, 'user.html', req)
  })

  app.get('/api/users/:jid', { preHandler: requireAuthApi }, async (req, reply) => {
    if (!isAccountDbReady()) return reply.status(503).send({ error: 'Not connected' })
    const { jid } = req.params as { jid: string }
    const user = getUser(jid)
    if (!user) return reply.status(404).send({ error: 'User not found' })

    const memberships = getUserGroupMemberships(jid)
    const activityData = getUserActivityPerGroup(jid, 30)
    const activityMap = new Map(activityData.map(a => [a.groupJid, a]))

    const allGroups = getAllGroups()
    const groupMap = new Map(allGroups.map(g => [g.jid, g]))
    const membershipGroupJids = new Set(memberships.map(m => m.groupJid))

    const rows = memberships.map(m => ({
      groupJid: m.groupJid,
      groupName: m.groupName,
      isCommunity: m.isCommunity,
      parentCommunityJid: m.parentCommunityJid,
      membership: m.membership,
      lastReadAt: m.lastReadAt,
      headerOnly: false,
      posts: activityMap.get(m.groupJid)?.posts ?? 0,
      reactions: activityMap.get(m.groupJid)?.reactions ?? 0,
      total: activityMap.get(m.groupJid)?.total ?? 0,
      lastActivity: activityMap.get(m.groupJid)?.lastActivity ?? null,
    }))

    // Add parent communities as header-only grouping rows if user is not directly in them
    const addedCommunities = new Set<string>()
    for (const m of memberships) {
      if (m.parentCommunityJid && !membershipGroupJids.has(m.parentCommunityJid) && !addedCommunities.has(m.parentCommunityJid)) {
        const g = groupMap.get(m.parentCommunityJid)
        if (g) {
          rows.push({
            groupJid: g.jid,
            groupName: g.name,
            isCommunity: true,
            parentCommunityJid: null,
            membership: 'none',
            lastReadAt: null,
            headerOnly: true,
            posts: 0,
            reactions: 0,
            total: 0,
            lastActivity: null,
          })
          addedCommunities.add(g.jid)
        }
      }
    }

    return reply.send({ user, memberships: rows })
  })

  app.get('/jobs', { preHandler: requireAuth }, async (req, reply) => {
    generateCsrf(req)
    return sendPage(reply, 'jobs.html', req)
  })

  app.get('/job/:id', { preHandler: requireAuth }, async (req, reply) => {
    generateCsrf(req)
    return sendPage(reply, 'job.html', req)
  })

  app.get('/api/jobs', { preHandler: requireAuthApi }, async (req, reply) => {
    if (!isAccountDbReady()) {
      return reply.send({ jobs: [], total: 0, page: 1, perPage: 0 })
    }
    const q = req.query as Record<string, string | undefined>
    const perPage = parseInt(getSettingOrDefault('page_size', '50'), 10) || 50
    const page = Math.max(1, parseInt(q.page || '1', 10) || 1)
    const status = botJobStatuses.includes(q.status as BotJobStatus) ? q.status as BotJobStatus : undefined
    const { jobs, total } = listJobs({
      status,
      jobType: q.type || undefined,
      groupJid: q.group || undefined,
      limit: perPage,
      offset: (page - 1) * perPage,
    })
    const nameByJid = new Map(getAllGroups().map(g => [g.jid, g.name]))
    const userNameByJid = new Map<string, string | null>()
    for (const j of jobs) {
      if (j.userJid && !userNameByJid.has(j.userJid)) {
        userNameByJid.set(j.userJid, getUser(j.userJid)?.displayName ?? null)
      }
    }
    return reply.send({
      jobs: jobs.map(j => ({
        ...j,
        groupName: j.groupJid ? nameByJid.get(j.groupJid) ?? null : null,
        userName: j.userJid ? userNameByJid.get(j.userJid) ?? null : null,
        tokensTotal: j.aiTokensIn + j.aiTokensOut,
      })),
      groups: listJobGroups().map(jid => ({ jid, name: nameByJid.get(jid) ?? jid })),
      total,
      page,
      perPage,
    })
  })

  app.get('/api/jobs/:id', { preHandler: requireAuthApi }, async (req, reply) => {
    if (!isAccountDbReady()) return reply.status(503).send({ error: 'Not connected' })
    const idNum = parseInt((req.params as { id: string }).id, 10)
    if (Number.isNaN(idNum)) return reply.status(400).send({ error: 'Invalid job id' })
    const job = getJob(idNum)
    if (!job) return reply.status(404).send({ error: 'Job not found' })
    const nameByJid = new Map(getAllGroups().map(g => [g.jid, g.name]))
    return reply.send({
      job,
      events: getJobEvents(job.id),
      groupName: job.groupJid ? nameByJid.get(job.groupJid) ?? null : null,
      userName: job.userJid ? getUser(job.userJid)?.displayName ?? null : null,
    })
  })

  app.get('/api/status', { preHandler: requireAuthApi }, async (_req, reply) => {
    const qr = getCurrentQr()
    const state = getConnectionState()
    const user = state === 'open' ? getBotUser() : null

    let qrDataUrl: string | null = null
    if (qr) {
      qrDataUrl = await QRCode.toDataURL(qr, { width: 300 })
    }

    return reply.send({
      qr: qrDataUrl,
      state: state ?? 'connecting',
      user,
    })
  })
}
