import { getSetting, getSettingOrDefault } from '../db/queries/settings.js'

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash'
export const DEFAULT_AI_DAILY_LIMIT = 300

export interface AiSettings {
  apiKey: string | null
  model: string
  dailyLimit: number
}

export function getAiSettings(): AiSettings {
  const raw = getSettingOrDefault('ai_daily_limit', String(DEFAULT_AI_DAILY_LIMIT))
  const parsed = parseInt(raw, 10)
  return {
    apiKey: getSetting('gemini_api_key') || null,
    model: getSettingOrDefault('gemini_model', DEFAULT_GEMINI_MODEL) || DEFAULT_GEMINI_MODEL,
    dailyLimit: Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_AI_DAILY_LIMIT,
  }
}
