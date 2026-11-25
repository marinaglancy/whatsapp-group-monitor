import { expandPlaceholders } from '../ai/settings.js'

/** A job failed for a reason the group may be told. `userText` goes into the
 *  `{{error}}` placeholder of the trigger's error template. */
export class TriggerJobError extends Error {
  constructor(public userText: string, message?: string) {
    super(message ?? userText)
    this.name = 'TriggerJobError'
  }
}

/** The job's trigger no longer exists: fail quietly, post nothing. */
export class TriggerGoneError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = 'TriggerGoneError'
  }
}

export const ERROR_TEXT = {
  busy: 'the AI service is busy right now, please try again in a minute',
  generic: 'something went wrong; details are in the admin panel job log',
  noApiKey: 'the AI is not set up yet (API key missing)',
  noOtherGroups: 'no other groups are in this tenant yet',
  invalidAnswer: 'the AI did not return a valid answer',
  aiCouldNotAnswer: 'the AI could not answer',
  dailyLimit: (limit: number) => `the daily AI usage limit (${limit} calls) is reached`,
}

/** Longest text put into `{{error}}`, so an error post stays readable. */
export const ERROR_TEXT_MAX = 500

/** The AI service says it is overloaded or out of quota. The SDK's error
 *  message is the JSON error body, so a 429 shows as "code":429 — a bare
 *  number would also match e.g. a daily limit of 429. */
export const AI_BUSY_RE = /"code":\s*429\b|too many requests|quota|rate.?limit|resource.?exhausted|overloaded|unavailable/i

/** Text for `{{error}}`: never internals. Stack frames are skipped because a
 *  line number like ":429:" is not a rate limit. */
export function errorTextFor(err: unknown, errorString: string): string {
  let text: string
  if (err instanceof TriggerJobError) {
    text = err.userText
  } else {
    const busy = AI_BUSY_RE.test(errorString.split('\n').filter(l => !/^\s+at /.test(l)).join('\n'))
    text = busy ? ERROR_TEXT.busy : ERROR_TEXT.generic
  }
  return text.slice(0, ERROR_TEXT_MAX)
}

export function renderErrorTemplate(
  template: string,
  v: { error: string; trigger: string; group: string; user: string; message: string },
): string {
  return expandPlaceholders(template, v)
}
