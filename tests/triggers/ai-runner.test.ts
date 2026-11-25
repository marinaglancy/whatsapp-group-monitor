import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedTenant } from '../helpers/fixtures.js'
import { fakeProvider } from '../helpers/fake-provider.js'
import { insertJob, getJob, getJobEvents, addJobAiUsage } from '../../src/db/queries/jobs.js'
import { resolveTenantScope, type QaScope } from '../../src/bot/scope.js'
import { buildAnswerSpec, type AiAnswerBase } from '../../src/triggers/ai-answer.js'
import { ERROR_TEXT, TriggerJobError } from '../../src/triggers/errors.js'
import type { AiSettings } from '../../src/ai/settings.js'
import type { BotJob } from '../../src/db/schema.js'
import {
  runAiAnswer, buildScopeListing, checkDailyLimit, AI_MAX_ROUNDS, type AiRunOptions,
} from '../../src/triggers/ai-runner.js'

const NOW_MS = Date.now()
const NOW_S = Math.floor(NOW_MS / 1000)

type TestAnswer = AiAnswerBase & { verdict?: string }
const TEST_SPEC = buildAnswerSpec<TestAnswer>({ verdict: { type: 'string' } }, 'Answer format: test.')
const SETTINGS: AiSettings = { apiKey: 'sk-test', model: 'test-model', dailyLimit: 0, timezone: 'UTC' }

let dbs: ReturnType<typeof setupTestDbs>
let scope: QaScope
let job: BotJob

beforeEach(() => {
  dbs = setupTestDbs()
  seedGroup('self@g.us', 'Home')
  seedGroup('a@g.us', 'Alpha')
  const tenantId = seedTenant('T', ['self@g.us', 'a@g.us'])
  scope = resolveTenantScope(tenantId, 'self@g.us')
  job = makeJob()
})
afterEach(() => { dbs.cleanup() })

function makeJob(): BotJob {
  const id = insertJob({ jobType: 'test_job', groupJid: 'self@g.us', userJid: 'u@lid', payload: {}, runAt: NOW_S })!
  return getJob(id)!
}

const verdict = (v: string) => ({ text: JSON.stringify({ error: false, verdict: v }) })
const toolRound = () => ({ toolCalls: [{ name: 'group_list', args: {} }] })

function options(
  provider: ReturnType<typeof fakeProvider>, extra: Partial<AiRunOptions<TestAnswer>> = {},
): AiRunOptions<TestAnswer> {
  return {
    job, provider, settings: SETTINGS,
    system: 'SYSTEM', messages: [{ role: 'user', text: 'Is this spam?' }], historyTurns: 0,
    scope, spec: TEST_SPEC, now: () => NOW_MS,
    toolValues: { timezone: 'Europe/Lisbon' },
    round1Request: { message: 'Is this spam?' },
    accept: a => !!a.verdict,
    ...extra,
  }
}

describe('runAiAnswer', () => {
  it('returns the accepted answer after a tool round and logs both rounds on the job', async () => {
    const provider = fakeProvider([
      { ...toolRound(), usage: { tokensIn: 100, tokensOut: 10 } },
      { ...verdict('spam'), usage: { tokensIn: 200, tokensOut: 20 } },
    ])
    const result = await runAiAnswer(options(provider))

    expect(result).toEqual({ error: false, verdict: 'spam' })
    expect(provider.calls[0].system).toBe('SYSTEM')
    expect(provider.calls[0].tools.length).toBeGreaterThan(0)
    // the given placeholder values reach the tool declarations
    expect(JSON.stringify(provider.calls[0].tools)).toContain('Europe/Lisbon')
    expect(JSON.stringify(provider.calls[0].tools)).not.toContain('{{')
    // the tool result is handed back on the next round
    expect(provider.calls[1].messages.some(m => m.role === 'tool' && m.name === 'group_list')).toBe(true)
    const events = getJobEvents(job.id)
    expect(events.map(e => e.eventType)).toEqual(['ai_call', 'tool_call', 'ai_call'])
    expect(events[0].data!.request).toEqual({
      system: 'SYSTEM', message: 'Is this spam?', historyTurns: 0,
      toolNames: provider.calls[0].tools.map(t => t.name),
    })
    expect(events[1].data).toMatchObject({ name: 'group_list' })
    const fresh = getJob(job.id)!
    expect(fresh.aiCalls).toBe(2)
    expect(fresh.aiTokensIn).toBe(300)
    expect(fresh.aiTokensOut).toBe(30)
  })

  it('makes the next round the final one, with the answer schema, when accept refuses a tool-round answer', async () => {
    const provider = fakeProvider([verdict(''), verdict('not spam')])
    const result = await runAiAnswer(options(provider))

    expect(result.verdict).toBe('not spam')
    expect(provider.calls[1].tools).toEqual([])
    expect(provider.calls[1].responseSchema).toEqual(TEST_SPEC.modelSchema)
    const aiCalls = getJobEvents(job.id).filter(e => e.eventType === 'ai_call')
    expect(aiCalls.map(e => e.data!.toolsOff)).toEqual([undefined, 'invalid answer'])
  })

  it('fails with the invalid-answer text when accept refuses the final-round answer too', async () => {
    const provider = fakeProvider([verdict(''), verdict('')])
    await expect(runAiAnswer(options(provider))).rejects.toMatchObject({ userText: ERROR_TEXT.invalidAnswer })
    expect(provider.calls.length).toBe(2)
  })

  it('fails with the AI\'s own message on error:true, or a plain text when it gives none', async () => {
    const withMessage = fakeProvider([{ text: JSON.stringify({ error: true, errormessage: ' the tools keep failing ' }) }])
    const err = await runAiAnswer(options(withMessage)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TriggerJobError)
    expect(err).toMatchObject({ userText: 'the tools keep failing' })

    const withoutMessage = fakeProvider([{ text: JSON.stringify({ error: true }) }])
    await expect(runAiAnswer(options(withoutMessage))).rejects.toMatchObject({ userText: ERROR_TEXT.aiCouldNotAnswer })
  })

  it('stops before round 2 when the daily limit is reached', async () => {
    const provider = fakeProvider([toolRound(), verdict('never reached')])
    const run = runAiAnswer(options(provider, { settings: { ...SETTINGS, dailyLimit: 1 } }))
    await expect(run).rejects.toMatchObject({ userText: ERROR_TEXT.dailyLimit(1) })
    expect(provider.calls.length).toBe(1)
  })

  it('sends no tools on the last round', async () => {
    const provider = fakeProvider([...Array.from({ length: AI_MAX_ROUNDS - 1 }, toolRound), verdict('spam')])
    await runAiAnswer(options(provider))
    expect(provider.calls.map(c => c.tools.length > 0)).toEqual([...Array(AI_MAX_ROUNDS - 1).fill(true), false])
  })
})

describe('checkDailyLimit', () => {
  it('throws the daily-limit error once today\'s calls reach the limit; 0 means no limit', () => {
    addJobAiUsage(job.id, { calls: 2, tokensIn: 1, tokensOut: 1 })
    expect(() => checkDailyLimit(3, () => NOW_MS)).not.toThrow()
    expect(() => checkDailyLimit(0, () => NOW_MS)).not.toThrow()
    expect(() => checkDailyLimit(2, () => NOW_MS)).toThrow(TriggerJobError)
    expect(() => checkDailyLimit(2, () => NOW_MS)).toThrow(ERROR_TEXT.dailyLimit(2))
  })
})

describe('buildScopeListing', () => {
  it('lists the date, the round budget and the groups, with the given label on the own group', () => {
    const lines = buildScopeListing(scope, Date.UTC(2026, 10, 25, 9, 30), 'UTC', 'the group where this message was posted')
    expect(lines[0]).toBe('Current date and time: 2026-11-25 09:30:00 (UTC).')
    expect(lines[1]).toContain(`${AI_MAX_ROUNDS - 1} rounds`)
    expect(lines[2]).toBe('Groups you can report on:')
    expect(lines[3]).toMatch(/^- "Home" \(self@g\.us\) — the group where this message was posted, data since \d{4}-\d\d-\d\d$/)
    expect(lines[4]).toMatch(/^- "Alpha" \(a@g\.us\) — data since \d{4}-\d\d-\d\d$/)
    expect(lines.length).toBe(5)
  })
})
