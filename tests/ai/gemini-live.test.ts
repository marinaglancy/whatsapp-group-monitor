import { describe, it, expect } from 'vitest'
import { createGeminiProvider } from '../../src/ai/gemini.js'
import type { AiChatMessage } from '../../src/ai/provider.js'
import { DEFAULT_GEMINI_MODEL } from '../../src/ai/settings.js'

const KEY = process.env.GEMINI_TEST_KEY

describe.skipIf(!KEY)('gemini live', () => {
  it('answers and reports usage', async () => {
    const provider = createGeminiProvider({ apiKey: KEY!, model: DEFAULT_GEMINI_MODEL })
    const resp = await provider.generate({
      system: 'You are a test. Reply with one word.',
      messages: [{ role: 'user', text: 'Say hello.' }],
      tools: [],
    })
    expect(resp.text).toBeTruthy()
    expect(resp.usage.tokensIn).toBeGreaterThan(0)
  }, 30_000)

  // The responder's last round: the history already holds a real tool call
  // (with its thought signature), and tool calls are switched off. Gemini must
  // accept that and answer in text.
  it('answers in text when tool calls are switched off after a tool round', async () => {
    const provider = createGeminiProvider({ apiKey: KEY!, model: DEFAULT_GEMINI_MODEL })
    const system = 'Always call get_time before answering a question about time.'
    const tools = [{ name: 'get_time', description: 'Current time.', parameters: { type: 'object', properties: {} } }]
    const messages: AiChatMessage[] = [{ role: 'user', text: 'What time is it?' }]

    const first = await provider.generate({ system, messages, tools })
    expect(first.toolCalls?.[0]?.name).toBe('get_time')
    messages.push({ role: 'assistant', toolCalls: first.toolCalls, raw: first.raw })
    messages.push({ role: 'tool', name: 'get_time', result: '{"time":"14:05"}' })

    const last = await provider.generate({ system, messages, tools, allowToolCalls: false })
    expect(last.toolCalls).toBeUndefined()
    expect(last.text).toMatch(/14[:.]05|2:05/)
  }, 60_000)
})
