import { buildAnswerSpec, type AiAnswerBase } from '../ai-answer.js'

export type QaAnswer = AiAnswerBase & { output?: string }

const QA_ANSWER_FORMAT = `Answer format: reply with exactly one JSON object and nothing else.
- When you can answer: {"error": false, "output": "<the answer, formatted for WhatsApp as described above>"}
- Only when you cannot answer at all (for example, the tools keep failing): {"error": true, "errormessage": "<one short sentence saying why>"}
"Nothing found" and "the data does not cover that period" are normal answers: put them in output.
Off-topic questions, greetings and thanks are normal answers too: reply to them in output.`

export const QA_ANSWER_SPEC = buildAnswerSpec<QaAnswer>({ output: { type: 'string' } }, QA_ANSWER_FORMAT)
