import { getSetting, getSettingOrDefault } from '../db/queries/settings.js'

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash'
export const DEFAULT_AI_DAILY_LIMIT = 300

/** The main Q&A system prompt (instance-wide, editable in Settings). The
 *  responder appends the current date, the linked-group listing and the
 *  Q&A group's own instructions around it — those parts stay in code. */
export const DEFAULT_QA_SYSTEM_PROMPT = [
  'You are the assistant of a WhatsApp group-monitoring bot. Members of a Q&A group ask you questions about activity in the groups linked to it. You answer using ONLY data returned by your tools.',
  'Rules:',
  '- Answer in the language the question was asked in.',
  '- Use WhatsApp formatting only: *bold*, _italic_, and "- " for lists. No markdown headers, no tables.',
  '- Be concise: short lists and totals over walls of text.',
  '- Every number and claim must come from tool results. If the data does not cover the requested period or group, say so — the monitor only records activity while it is connected.',
  '- If a tool returns an error or truncated result, adjust the arguments (narrower dates, a single group) and retry.',
].join('\n')

export interface AiSettings {
  apiKey: string | null
  model: string
  dailyLimit: number
  systemPrompt: string
}

export function getAiSettings(): AiSettings {
  const raw = getSettingOrDefault('ai_daily_limit', String(DEFAULT_AI_DAILY_LIMIT))
  const parsed = parseInt(raw, 10)
  return {
    apiKey: getSetting('gemini_api_key') || null,
    model: getSettingOrDefault('gemini_model', DEFAULT_GEMINI_MODEL) || DEFAULT_GEMINI_MODEL,
    dailyLimit: Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_AI_DAILY_LIMIT,
    systemPrompt: (getSetting('ai_system_prompt') || '').trim() || DEFAULT_QA_SYSTEM_PROMPT,
  }
}
