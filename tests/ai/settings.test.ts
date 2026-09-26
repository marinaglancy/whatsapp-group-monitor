import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDbs } from '../helpers/db.js'
import { setSetting } from '../../src/db/queries/settings.js'
import {
  getAiSettings, expandPlaceholders,
  DEFAULT_GEMINI_MODEL, DEFAULT_AI_DAILY_LIMIT, DEFAULT_QA_SYSTEM_PROMPT, DEFAULT_TIMEZONE,
} from '../../src/ai/settings.js'

let dbs: ReturnType<typeof setupTestDbs>
beforeEach(() => { dbs = setupTestDbs() })
afterEach(() => { dbs.cleanup() })

describe('getAiSettings', () => {
  it('returns defaults when nothing is configured', () => {
    expect(getAiSettings()).toEqual({
      apiKey: null,
      model: DEFAULT_GEMINI_MODEL,
      dailyLimit: DEFAULT_AI_DAILY_LIMIT,
      systemPrompt: DEFAULT_QA_SYSTEM_PROMPT,
      timezone: DEFAULT_TIMEZONE,
    })
  })

  it('returns configured values', () => {
    setSetting('gemini_api_key', 'sk-test')
    setSetting('gemini_model', 'gemini-3.7-flash')
    setSetting('ai_daily_limit', '50')
    setSetting('ai_system_prompt', 'You are a pirate.')
    setSetting('timezone', 'Europe/Lisbon')
    expect(getAiSettings()).toEqual({
      apiKey: 'sk-test',
      model: 'gemini-3.7-flash',
      dailyLimit: 50,
      systemPrompt: 'You are a pirate.',
      timezone: 'Europe/Lisbon',
    })
  })

  it('falls back to UTC for an invalid stored timezone', () => {
    setSetting('timezone', 'Mars/Olympus_Mons')
    expect(getAiSettings().timezone).toBe(DEFAULT_TIMEZONE)
  })

  it('ships a default prompt that references the timezone and bot lid via placeholders', () => {
    expect(DEFAULT_QA_SYSTEM_PROMPT).toContain('{{timezone}}')
    expect(DEFAULT_QA_SYSTEM_PROMPT).toContain('{{botlid}}')
  })

  it('never exposes the "Q&A" app jargon to the model', () => {
    expect(DEFAULT_QA_SYSTEM_PROMPT).not.toMatch(/Q&A/i)
  })

  it('explains that join dates are only known for observed joins', () => {
    expect(DEFAULT_QA_SYSTEM_PROMPT).toMatch(/join date/i)
  })

  it('falls back to the default prompt when the stored one is blank', () => {
    setSetting('ai_system_prompt', '   ')
    expect(getAiSettings().systemPrompt).toBe(DEFAULT_QA_SYSTEM_PROMPT)
  })

  it('treats empty key as null and 0 as unlimited', () => {
    setSetting('gemini_api_key', '')
    setSetting('ai_daily_limit', '0')
    expect(getAiSettings().apiKey).toBeNull()
    expect(getAiSettings().dailyLimit).toBe(0)
  })

  it('expandPlaceholders replaces every {{timezone}} and leaves unknown tokens alone', () => {
    const out = expandPlaceholders('Times in {{timezone}}; repeat: {{timezone}}; keep {{unknown}}.', { timezone: 'Europe/Lisbon' })
    expect(out).toBe('Times in Europe/Lisbon; repeat: Europe/Lisbon; keep {{unknown}}.')
  })

  it('falls back to the default limit on garbage values', () => {
    setSetting('ai_daily_limit', 'many')
    expect(getAiSettings().dailyLimit).toBe(DEFAULT_AI_DAILY_LIMIT)
    setSetting('ai_daily_limit', '-5')
    expect(getAiSettings().dailyLimit).toBe(DEFAULT_AI_DAILY_LIMIT)
  })
})
