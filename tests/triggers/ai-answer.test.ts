import { describe, it, expect } from 'vitest'
import { parseAiAnswer, buildAnswerSpec } from '../../src/triggers/ai-answer.js'
import { QA_ANSWER_SPEC } from '../../src/triggers/qa/answer.js'

describe('parseAiAnswer', () => {
  it('accepts an ok answer and an error answer', () => {
    expect(parseAiAnswer('{"error":false,"output":"hi"}', QA_ANSWER_SPEC)).toEqual({ error: false, output: 'hi' })
    expect(parseAiAnswer('{"error":true}', QA_ANSWER_SPEC)).toEqual({ error: true })
    expect(parseAiAnswer('{"error":true,"errormessage":"tools failed"}', QA_ANSWER_SPEC)).toEqual({ error: true, errormessage: 'tools failed' })
  })

  it('rejects an ok answer without output, prose, and broken JSON', () => {
    expect(parseAiAnswer('{"error":false}', QA_ANSWER_SPEC)).toBeNull()
    expect(parseAiAnswer('{"error":false,"output":5}', QA_ANSWER_SPEC)).toBeNull()
    expect(parseAiAnswer('{"error":"no"}', QA_ANSWER_SPEC)).toBeNull()
    expect(parseAiAnswer('{"error":true,"errormessage":3}', QA_ANSWER_SPEC)).toBeNull()
    expect(parseAiAnswer('Here is the answer: 42', QA_ANSWER_SPEC)).toBeNull()
    expect(parseAiAnswer('{"error":false,', QA_ANSWER_SPEC)).toBeNull()
    expect(parseAiAnswer('[1]', QA_ANSWER_SPEC)).toBeNull()
    expect(parseAiAnswer(undefined, QA_ANSWER_SPEC)).toBeNull()
    expect(parseAiAnswer('', QA_ANSWER_SPEC)).toBeNull()
  })

  it('accepts a ```json fenced answer (Review Focus 4)', () => {
    expect(parseAiAnswer('```json\n{"error":false,"output":"x"}\n```', QA_ANSWER_SPEC)).toEqual({ error: false, output: 'x' })
    expect(parseAiAnswer('  ```\n{"error":false,"output":"x"}\n```  ', QA_ANSWER_SPEC)).toEqual({ error: false, output: 'x' })
  })

  it('builds the model schema from the extra properties', () => {
    const spec = buildAnswerSpec({ output: { type: 'string' } }, 'fmt')
    expect(spec.modelSchema).toEqual({
      type: 'object',
      properties: { error: { type: 'boolean' }, errormessage: { type: 'string' }, output: { type: 'string' } },
      required: ['error'],
    })
    expect(spec.formatSection).toBe('fmt')
  })
})
