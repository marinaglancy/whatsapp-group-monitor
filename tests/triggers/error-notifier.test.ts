import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { logger } from '../../src/utils/logger.js'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedUser, seedMessage, seedTenant, seedQaTrigger } from '../helpers/fixtures.js'
import { updateTrigger, createTrigger } from '../../src/db/queries/triggers.js'
import { insertJob, getJob, getJobEvents, addJobEvent } from '../../src/db/queries/jobs.js'
import { buildTriggerErrorNotifier, resetErrorThrottleForTests, type ErrorTarget } from '../../src/triggers/error-notifier.js'
import { registerBuiltinTriggerTypes } from '../../src/triggers/index.js'
import { registerTriggerType, clearTriggerTypesForTests } from '../../src/triggers/registry.js'
import { TriggerType, type BaseTriggerConfig, type TriggerEvent } from '../../src/triggers/types.js'
import { QA_TRIGGER_DEFAULTS } from '../../src/triggers/qa/defaults.js'
import type { QaTriggerConfig } from '../../src/triggers/qa/type.js'
import { TriggerJobError, ERROR_TEXT } from '../../src/triggers/errors.js'
import type { BotJob, BotTrigger } from '../../src/db/schema.js'

const NOW_S = Math.floor(Date.now() / 1000)
const NOW_MS = NOW_S * 1000
const TEN_MIN = 10 * 60_000

/** A type that posts its errors elsewhere, like Spam will: its own default template. */
class ReportType extends TriggerType<BaseTriggerConfig> {
  readonly id = 'report'
  readonly displayName = 'Report'
  readonly eventKind = 'group_message' as const
  readonly jobType = 'report_job'
  readonly defaultPrompt = ''
  readonly defaultErrorTemplate = 'Check failed for {{user}} in {{group}}: {{error}}'
  defaults(): BaseTriggerConfig { return { onlyIfFirst: false, waitSeconds: 0, maxAgeMinutes: 60, errorTemplate: '' } }
  validate(raw: unknown) { return { ok: true as const, config: this.normalize(raw as Record<string, unknown>) } }
  summarize() { return 'report' }
  watches() { return true }
  buildJob(event: TriggerEvent) {
    const r = event.record
    return { groupJid: r.groupJid, userJid: r.userJid, messageId: r.messageId, payload: {} }
  }
}

let dbs: ReturnType<typeof setupTestDbs>
let sent: { text: string; jobId: number; triggerId?: number }[]
let tenantId: number
let triggerId: number

beforeEach(() => {
  dbs = setupTestDbs()
  sent = []
  clearTriggerTypesForTests()
  registerBuiltinTriggerTypes()
  registerTriggerType(new ReportType())
  resetErrorThrottleForTests()
  seedGroup('qa@g.us', 'Admins')
  seedGroup('a@g.us', 'Alpha')
  seedUser('asker@lid', 'Anna', '4917612345678')
  tenantId = seedTenant('T', ['qa@g.us', 'a@g.us'])
  triggerId = seedQaTrigger(tenantId, 'qa@g.us')
})
afterEach(() => {
  vi.restoreAllMocks()
  dbs.cleanup()
})

function makeJob(
  text = 'how many messages in September?',
  over: { jobType?: string; groupJid?: string; triggerId?: number } = {},
): BotJob {
  const groupJid = over.groupJid ?? 'qa@g.us'
  const qId = seedMessage(groupJid, 'asker@lid', text, NOW_S - 5)
  const id = insertJob({
    jobType: over.jobType ?? 'qa_answer', groupJid, userJid: 'asker@lid', messageId: qId,
    triggerId: over.triggerId ?? triggerId, payload: { text }, runAt: NOW_S, expiresAt: NOW_S + 600,
  })!
  return getJob(id)!
}

function setTriggerConfig(config: Partial<QaTriggerConfig>, name?: string): void {
  updateTrigger(triggerId, { ...(name ? { name } : {}), config: { ...QA_TRIGGER_DEFAULTS, qaGroupJid: 'qa@g.us', ...config } })
}

/** Mentions' target: a reply to the question, never throttled. */
function makeNotifier() {
  return buildTriggerErrorNotifier({
    send: async (job, _t, text) => {
      sent.push({ text, jobId: job.id })
      return { groupJid: job.groupJid!, messageId: `ERR${sent.length}` }
    },
    throttleMs: 0,
  })
}

describe('trigger error notifier', () => {
  it('notifier posts the rendered template with the error text and records error_sent', async () => {
    const notify = makeNotifier()
    const limited = makeJob('limited q')
    const err = new TriggerJobError(ERROR_TEXT.dailyLimit(3))
    await notify(limited, err.stack!, err)
    expect(sent).toEqual([{ text: '⚠️ Sorry, I could not answer: the daily AI usage limit (3 calls) is reached', jobId: limited.id }])
    const events = getJobEvents(limited.id)
    expect(events.map(e => e.eventType)).toEqual(['error_sent']) // not a reply_sent
    expect(events[0]).toMatchObject({ groupJid: 'qa@g.us', messageId: 'ERR1' })

    // errors that are not ours: busy for a 429, generic otherwise, never internals
    await notify(makeJob('busy q'), 'Error: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}', new Error('x'))
    expect(sent[1].text).toBe('⚠️ Sorry, I could not answer: the AI service is busy right now, please try again in a minute')
    await notify(makeJob('crash q'), 'TypeError: boom\n    at handleQaAnswer (/app/src/bot/responder.ts:429:12)', new TypeError('boom'))
    expect(sent[2].text).toBe('⚠️ Sorry, I could not answer: something went wrong; details are in the admin panel job log')
  })

  it('notifier uses the trigger\'s own template and placeholders', async () => {
    setTriggerConfig({ errorTemplate: '{{trigger}} in {{group}} for {{user}} about "{{message}}": {{error}}' }, 'Ask me')
    const question = 'q'.repeat(250)
    const job = makeJob(question)
    await makeNotifier()(job, 'x', new TriggerJobError('the AI could not answer'))
    expect(sent.map(s => s.text)).toEqual([`Ask me in Admins for @asker about "${'q'.repeat(200)}": the AI could not answer`])

    // a long AI message is cut before it goes into {{error}} (Review Focus 5)
    setTriggerConfig({ errorTemplate: '{{error}}' })
    await makeNotifier()(makeJob('long'), 'x', new TriggerJobError('e'.repeat(900)))
    expect(sent[1].text).toBe('e'.repeat(500))

    // a blank template means the default
    setTriggerConfig({ errorTemplate: '   ' })
    await makeNotifier()(makeJob('blank template'), 'x', new TriggerJobError('the AI could not answer'))
    expect(sent[2].text).toBe('⚠️ Sorry, I could not answer: the AI could not answer')
  })

  it('notifier stays silent once the answer was sent', async () => {
    const answered = makeJob('answered q')
    addJobEvent(answered.id, 'reply_sent', { messageId: 'X' })
    await makeNotifier()(answered, 'crashed after send', new Error('crashed after send'))
    expect(sent).toEqual([])
    expect(getJobEvents(answered.id).map(e => e.eventType)).toEqual(['reply_sent'])
  })
})

describe('trigger error notifier with a throttled target', () => {
  let clock: number
  let reportTriggerId: number

  beforeEach(() => {
    clock = NOW_MS
    reportTriggerId = createTrigger({
      tenantId, type: 'report', name: 'Spam watch', config: new ReportType().defaults() as unknown as Record<string, unknown>,
    })
  })

  const target = (over: Partial<ErrorTarget> = {}): ErrorTarget => ({
    send: async (job, trigger: BotTrigger, text) => {
      sent.push({ text, jobId: job.id, triggerId: trigger.id })
      return { groupJid: 'reports@g.us', messageId: `ERR${sent.length}` }
    },
    throttleMs: TEN_MIN,
    ...over,
  })
  const reportJob = (text = 'buy now', id = reportTriggerId) => makeJob(text, { jobType: 'report_job', groupJid: 'a@g.us', triggerId: id })
  const fail = new TriggerJobError(ERROR_TEXT.dailyLimit(3))

  it('uses the type\'s default template and hands the trigger to the target', async () => {
    const job = reportJob()
    await buildTriggerErrorNotifier(target(), () => clock)(job, 'x', fail)
    expect(sent).toEqual([{
      text: 'Check failed for @asker in Alpha: the daily AI usage limit (3 calls) is reached',
      jobId: job.id, triggerId: reportTriggerId,
    }])
    // the event says where the error was posted, not the job's group
    expect(getJobEvents(job.id)[0]).toMatchObject({ eventType: 'error_sent', groupJid: 'reports@g.us', messageId: 'ERR1' })
  })

  it('posts at most once per trigger in the period; after it, posts again', async () => {
    const notify = buildTriggerErrorNotifier(target(), () => clock)
    const first = reportJob('one')
    await notify(first, 'x', fail)
    clock += TEN_MIN - 1
    const second = reportJob('two')
    await notify(second, 'x', fail)
    expect(sent.map(s => s.jobId)).toEqual([first.id])
    expect(getJobEvents(second.id)).toEqual([]) // only in the job log

    clock += 1 // ten minutes after the first post
    const third = reportJob('three')
    await notify(third, 'x', fail)
    expect(sent.map(s => s.jobId)).toEqual([first.id, third.id])
  })

  it('throttles each trigger on its own', async () => {
    const otherId = createTrigger({
      tenantId, type: 'report', name: 'Other', config: new ReportType().defaults() as unknown as Record<string, unknown>,
    })
    const notify = buildTriggerErrorNotifier(target(), () => clock)
    await notify(reportJob('one'), 'x', fail)
    await notify(reportJob('two', otherId), 'x', fail)
    expect(sent.map(s => s.triggerId)).toEqual([reportTriggerId, otherId])
  })

  it('a send that fails does not count as a post', async () => {
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    let down = true
    const notify = buildTriggerErrorNotifier(target({
      send: async (job, trigger, text) => {
        if (down) throw new Error('Connection Closed')
        sent.push({ text, jobId: job.id, triggerId: trigger.id })
        return { groupJid: 'reports@g.us', messageId: 'ERR' }
      },
    }), () => clock)
    const first = reportJob('one')
    await notify(first, 'x', fail)
    expect(getJobEvents(first.id)).toEqual([])
    expect(logged).toHaveBeenCalledWith(expect.anything(), 'Failed to send the error message')

    down = false
    clock += 60_000
    const second = reportJob('two')
    await notify(second, 'x', fail)
    expect(sent.map(s => s.jobId)).toEqual([second.id])
  })

  it('a send that posts nothing does not count as a post and is only logged', async () => {
    const logged = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    let posting = false
    const notify = buildTriggerErrorNotifier(target({
      send: async (job, trigger, text) => {
        if (!posting) return null
        sent.push({ text, jobId: job.id, triggerId: trigger.id })
        return { groupJid: 'reports@g.us', messageId: 'ERR' }
      },
    }), () => clock)
    const first = reportJob('one')
    await notify(first, 'x', fail)
    expect(getJobEvents(first.id)).toEqual([])
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ jobId: first.id }), 'Error message not posted: nowhere to post it')

    posting = true
    clock += 60_000 // well within the period
    const second = reportJob('two')
    await notify(second, 'x', fail)
    expect(sent.map(s => s.jobId)).toEqual([second.id])
    expect(getJobEvents(second.id)[0]).toMatchObject({ eventType: 'error_sent', groupJid: 'reports@g.us', messageId: 'ERR' })
  })

  it('silent cases do not use up the period', async () => {
    const notify = buildTriggerErrorNotifier(target(), () => clock)
    const answered = reportJob('done')
    addJobEvent(answered.id, 'reply_sent', { messageId: 'X' })
    await notify(answered, 'x', fail)
    const next = reportJob('next')
    await notify(next, 'x', fail)
    expect(sent.map(s => s.jobId)).toEqual([next.id])
  })
})
