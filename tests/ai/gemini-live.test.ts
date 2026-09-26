import { describe, it, expect } from 'vitest'
import { createGeminiProvider } from '../../src/ai/gemini.js'
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
})
