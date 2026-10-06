import { describe, it, expect } from 'vitest'
import { createGeminiProvider } from '../../src/ai/gemini.js'
import type { AiChatMessage } from '../../src/ai/provider.js'
import { buildFinalRoundMessages } from '../../src/bot/responder.js'
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

  // The responder's last round, exactly as it builds it: the earlier tool
  // call and its result folded into the question as text, and no tools sent.
  // (Sending the tools with calling switched off did NOT work: Gemini kept
  // calling tools, even made-up ones.)
  it('answers in text on a last round built from a real tool round', async () => {
    const provider = createGeminiProvider({ apiKey: KEY!, model: DEFAULT_GEMINI_MODEL })
    const system = 'Always call get_time before answering a question about time.'
    const tools = [{ name: 'get_time', description: 'Current time.', parameters: { type: 'object', properties: {} } }]
    const messages: AiChatMessage[] = [{ role: 'user', text: 'What time is it?' }]

    const first = await provider.generate({ system, messages, tools })
    expect(first.toolCalls?.[0]?.name).toBe('get_time')
    messages.push({ role: 'assistant', toolCalls: first.toolCalls, raw: first.raw })
    messages.push({ role: 'tool', name: 'get_time', result: '{"time":"14:05"}' })

    const last = await provider.generate({ system, messages: buildFinalRoundMessages(messages, 0), tools: [] })
    expect(last.toolCalls).toBeUndefined()
    expect(last.text).toMatch(/14[:.]05|2:05/)
  }, 60_000)
})
