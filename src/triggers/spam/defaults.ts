import type { SpamTriggerConfig } from './type.js'

export const SPAM_DEFAULT_ERROR_TEMPLATE = '⚠️ Spam check failed for a message by {{user}} in {{group}}: {{error}}'

/** WhatsApp lets a message be edited for 15 minutes; keep one minute of margin. */
export const SPAM_EDIT_WINDOW_MS = 14 * 60_000
/** How long an earlier verdict on the same text from the same user can be reused. */
export const SPAM_REUSE_WINDOW_MS = 15 * 60_000

export const DEFAULT_SPAM_PROMPT = [
  'You judge one WhatsApp message for spam. The message was posted in the group {{group}} by {{user}}.',
  'The message:',
  '{{message}}',
  'Decide if it is spam (unwanted advertising, scams, mass-posted links or similar) or not.',
  'You may use your tools to look at what this sender did in other groups, for example whether the same text was posted many times.',
  'Use only facts from the message and the tool results. If you are not sure, say it is suspicious rather than spam.',
].join('\n')

export const SPAM_TRIGGER_DEFAULTS: SpamTriggerConfig = {
  groupsMode: 'all',
  groupJids: [],
  botRole: 'any',
  contentEnabled: true,
  contentLink: true,
  contentImage: true,
  contentRegex: '',
  senderNotAdmin: true,
  joinedWithinDays: null,
  maxMessages: null,
  reportGroupJid: '',
  onlyIfFirst: false,
  waitSeconds: 10,
  maxAgeMinutes: 60,
  prompt: '',
  instructions: '',
  errorTemplate: '',
}
