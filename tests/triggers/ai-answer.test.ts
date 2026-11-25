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

  it('sends output as required to the model but accepts an error answer without it', () => {
    expect(QA_ANSWER_SPEC.modelSchema.required).toEqual(['error', 'output'])
    expect(parseAiAnswer('{"error":true,"errormessage":"x"}', QA_ANSWER_SPEC)).not.toBeNull()
  })

  it('accepts a ```json fenced answer (Review Focus 4)', () => {
    expect(parseAiAnswer('```json\n{"error":false,"output":"x"}\n```', QA_ANSWER_SPEC)).toEqual({ error: false, output: 'x' })
    expect(parseAiAnswer('  ```\n{"error":false,"output":"x"}\n```  ', QA_ANSWER_SPEC)).toEqual({ error: false, output: 'x' })
  })

  it('tells the AI that off-topic questions are normal answers', () => {
    expect(QA_ANSWER_SPEC.formatSection).toContain('Off-topic questions')
    expect(QA_ANSWER_SPEC.formatSection.endsWith(
      'Off-topic questions, greetings and thanks are normal answers too: reply to them in output.')).toBe(true)
  })

  it('builds the model schema from the extra properties', () => {
    const spec = buildAnswerSpec({ output: { type: 'string' } }, 'fmt')
    expect(spec.modelSchema).toEqual({
      type: 'object',
      properties: { error: { type: 'boolean' }, errormessage: { type: 'string' }, output: { type: 'string' } },
      required: ['error', 'output'],
    })
    expect(spec.formatSection).toBe('fmt')
  })
})
