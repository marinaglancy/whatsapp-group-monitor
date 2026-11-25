import { getSetting, getSettingOrDefault } from '../db/queries/settings.js'
import { DEFAULT_QA_SYSTEM_PROMPT } from '../triggers/qa/defaults.js'

export { DEFAULT_QA_SYSTEM_PROMPT }

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash'
export const DEFAULT_AI_DAILY_LIMIT = 300
export const DEFAULT_TIMEZONE = 'UTC'

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Replace {{placeholder}} tokens (e.g. {{timezone}}) in model-bound text.
 *  Unknown placeholders are left untouched. Run on the system prompt, per-group
 *  instructions and tool declarations before anything is sent to the model. */
export function expandPlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (token, key: string) => values[key] ?? token)
}

export interface AiSettings {
  apiKey: string | null
  model: string
  dailyLimit: number
  systemPrompt: string
  timezone: string
}

export function getAiSettings(): AiSettings {
  const raw = getSettingOrDefault('ai_daily_limit', String(DEFAULT_AI_DAILY_LIMIT))
  const parsed = parseInt(raw, 10)
  const tz = (getSetting('timezone') || '').trim()
  return {
    apiKey: getSetting('gemini_api_key') || null,
    model: getSettingOrDefault('gemini_model', DEFAULT_GEMINI_MODEL) || DEFAULT_GEMINI_MODEL,
    dailyLimit: Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_AI_DAILY_LIMIT,
    systemPrompt: (getSetting('ai_system_prompt') || '').trim() || DEFAULT_QA_SYSTEM_PROMPT,
    timezone: tz && isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE,
  }
}
