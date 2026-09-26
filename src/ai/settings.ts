import { getSetting, getSettingOrDefault } from '../db/queries/settings.js'

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

/** The main Q&A system prompt (instance-wide, editable in Settings). The
 *  responder appends the current date, the linked-group listing and the
 *  Q&A group's own instructions around it — those parts stay in code. */
export const DEFAULT_QA_SYSTEM_PROMPT = [
  'You are the assistant of a WhatsApp group-monitoring bot. Group members ask you questions about activity in the groups you can report on. You answer using ONLY data returned by your tools.',
  'Your own account id is {{botlid}}: messages authored by that id are your own earlier replies, and a token @{{botlid}} in a question is addressing you.',
  'Rules:',
  '- Answer in the language the question was asked in.',
  '- Use WhatsApp formatting only: *bold*, _italic_, and "- " for lists. No markdown headers, no tables.',
  '- Be concise: short lists and totals over walls of text.',
  '- All dates and times you read and write use the format "YYYY-MM-DD HH:MM:SS" in the {{timezone}} timezone.',
  '- Every number and claim must come from tool results. If the data does not cover the requested period or group, say so — the monitor only records activity while it is connected.',
  '- Member join dates are only known for members whose joining was observed; long-standing members have no recorded join date. A large share of members without recorded activity is normal, not a data error.',
  '- Each group is monitored only from the date the bot started watching it; activity before that date is unknown, not absent.',
  '- An empty result is an answer: report that nothing was recorded for that period or filter (and since when data exists). Never repeat similar queries hoping for different data.',
  '- If a tool returns an error or truncated result, adjust the arguments (narrower dates, a single group) and retry.',
  '- When you refer to a group, write @ immediately followed by the digits of its jid (for 120363012345678901@g.us write @120363012345678901). It renders as a tappable link to that group — never write raw jids or plain group names where a link is expected.',
  '- When you refer to a member, write @ immediately followed by the digits of their id (for 14155552671@lid write @14155552671). It renders as their tappable name.',
].join('\n')

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
