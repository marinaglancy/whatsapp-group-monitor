import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDbs } from '../helpers/db.js'
import { setSetting } from '../../src/db/queries/settings.js'
import { getAiSettings, DEFAULT_GEMINI_MODEL, DEFAULT_AI_DAILY_LIMIT } from '../../src/ai/settings.js'

let dbs: ReturnType<typeof setupTestDbs>
beforeEach(() => { dbs = setupTestDbs() })
afterEach(() => { dbs.cleanup() })

describe('getAiSettings', () => {
  it('returns defaults when nothing is configured', () => {
    expect(getAiSettings()).toEqual({ apiKey: null, model: DEFAULT_GEMINI_MODEL, dailyLimit: DEFAULT_AI_DAILY_LIMIT })
  })

  it('returns configured values', () => {
    setSetting('gemini_api_key', 'sk-test')
    setSetting('gemini_model', 'gemini-3.7-flash')
    setSetting('ai_daily_limit', '50')
    expect(getAiSettings()).toEqual({ apiKey: 'sk-test', model: 'gemini-3.7-flash', dailyLimit: 50 })
  })

  it('treats empty key as null and 0 as unlimited', () => {
    setSetting('gemini_api_key', '')
    setSetting('ai_daily_limit', '0')
    expect(getAiSettings().apiKey).toBeNull()
    expect(getAiSettings().dailyLimit).toBe(0)
  })

  it('falls back to the default limit on garbage values', () => {
    setSetting('ai_daily_limit', 'many')
    expect(getAiSettings().dailyLimit).toBe(DEFAULT_AI_DAILY_LIMIT)
    setSetting('ai_daily_limit', '-5')
    expect(getAiSettings().dailyLimit).toBe(DEFAULT_AI_DAILY_LIMIT)
  })
})
