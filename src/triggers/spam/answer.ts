import { buildAnswerSpec, type AiAnswerBase } from '../ai-answer.js'

export type SpamAnswer = AiAnswerBase & { isspam?: boolean; isspammer?: boolean; reason?: string }

const SPAM_ANSWER_FORMAT = `Answer format: reply with exactly one JSON object and nothing else.
- When you can judge the message: {"error": false, "isspam": <true or false>, "isspammer": <true or false>, "reason": "<one or two short sentences>"}
- "isspam" is true when the message is spam.
- "isspammer" is true only when the account posts spam deliberately. An ad from a long-time member that breaks the group rules is spam, but that member is not a spammer.
- A spammer's message is always spam: never set "isspammer" to true with "isspam" false.
- Only when you cannot judge at all (for example, the tools keep failing): {"error": true, "errormessage": "<one short sentence saying why>"}`

export const SPAM_ANSWER_SPEC = buildAnswerSpec<SpamAnswer>(
  { isspam: { type: 'boolean' }, isspammer: { type: 'boolean' }, reason: { type: 'string' } },
  SPAM_ANSWER_FORMAT,
)
