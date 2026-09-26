import { describe, it, expect } from 'vitest'
import { toGeminiContents, toGeminiTools, fromGeminiResponse } from '../../src/ai/gemini.js'

describe('toGeminiContents', () => {
  it('maps user, assistant tool-calls, tool results and assistant text', () => {
    const contents = toGeminiContents([
      { role: 'user', text: 'how many messages?' },
      { role: 'assistant', toolCalls: [{ name: 'activity_stats', args: { from: '2026-09-01', to: '2026-09-30' } }] },
      { role: 'tool', name: 'activity_stats', result: '{"ranges":[]}' },
      { role: 'assistant', text: 'None.' },
    ])
    expect(contents).toEqual([
      { role: 'user', parts: [{ text: 'how many messages?' }] },
      { role: 'model', parts: [{ functionCall: { name: 'activity_stats', args: { from: '2026-09-01', to: '2026-09-30' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'activity_stats', response: { result: '{"ranges":[]}' } } }] },
      { role: 'model', parts: [{ text: 'None.' }] },
    ])
  })
})

describe('toGeminiContents: provider raw echo', () => {
  it('echoes the raw model content verbatim for assistant turns (preserves thought signatures)', () => {
    const raw = {
      role: 'model',
      parts: [{ functionCall: { name: 'group_list', args: {} }, thoughtSignature: 'SIG123' }],
    }
    const contents = toGeminiContents([
      { role: 'user', text: 'q' },
      { role: 'assistant', toolCalls: [{ name: 'group_list', args: {} }], raw },
    ])
    expect(contents[1]).toBe(raw)
  })

  it('coalesces consecutive tool results into one user turn with multiple functionResponse parts', () => {
    const contents = toGeminiContents([
      { role: 'tool', name: 'a', result: '1' },
      { role: 'tool', name: 'b', result: '2' },
      { role: 'user', text: 'next' },
    ])
    expect(contents).toEqual([
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'a', response: { result: '1' } } },
          { functionResponse: { name: 'b', response: { result: '2' } } },
        ],
      },
      { role: 'user', parts: [{ text: 'next' }] },
    ])
  })
})

describe('toGeminiTools', () => {
  it('passes parameters and responseJsonSchema through to function declarations', () => {
    const params = { type: 'object', properties: { limit: { type: 'integer' } } }
    const respSchema = { type: 'object', properties: { total: { type: 'integer' } } }
    expect(toGeminiTools([
      { name: 'group_list', description: 'List groups.', parameters: params, responseJsonSchema: respSchema },
    ])).toEqual([{
      functionDeclarations: [
        { name: 'group_list', description: 'List groups.', parametersJsonSchema: params, responseJsonSchema: respSchema },
      ],
    }])
  })

  it('returns undefined for an empty tool list', () => {
    expect(toGeminiTools([])).toBeUndefined()
  })
})

describe('fromGeminiResponse', () => {
  it('extracts text and usage', () => {
    const r = fromGeminiResponse({ text: 'Answer', usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 15 } })
    expect(r).toEqual({ text: 'Answer', toolCalls: undefined, usage: { tokensIn: 120, tokensOut: 15 } })
  })

  it('extracts tool calls and defaults missing args to {}', () => {
    const r = fromGeminiResponse({ functionCalls: [{ name: 'group_list' }, { name: 'x', args: { a: 1 } }] })
    expect(r.toolCalls).toEqual([{ name: 'group_list', args: {} }, { name: 'x', args: { a: 1 } }])
    expect(r.usage).toEqual({ tokensIn: 0, tokensOut: 0 })
  })

  it('handles a fully empty response', () => {
    const r = fromGeminiResponse({})
    expect(r.text).toBeUndefined()
    expect(r.toolCalls).toBeUndefined()
  })

  it('drops nameless function calls', () => {
    const r = fromGeminiResponse({ functionCalls: [{ args: { a: 1 } }] })
    expect(r.toolCalls).toBeUndefined()
  })
})
