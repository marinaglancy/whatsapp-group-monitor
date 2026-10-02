import type { AiChatMessage, AiProvider, AiRequest, AiResponse, AiToolDef } from '../../src/ai/provider.js'

export interface FakeCall {
  system: string
  messages: AiChatMessage[]
  tools: AiToolDef[]
  allowToolCalls: boolean
}

/** Scripted provider: each generate() shifts the next scripted response.
 *  Usage defaults to { tokensIn: 10, tokensOut: 5 } unless the script overrides it. */
export function fakeProvider(script: Array<Partial<AiResponse>>) {
  const calls: FakeCall[] = []
  const provider = {
    calls,
    async generate(req: AiRequest) {
      calls.push({ system: req.system, messages: [...req.messages], tools: req.tools, allowToolCalls: req.allowToolCalls ?? true })
      const next = script.shift()
      if (!next) throw new Error('fakeProvider script exhausted')
      return { usage: { tokensIn: 10, tokensOut: 5 }, ...next } as AiResponse
    },
  }
  return provider as AiProvider & { calls: FakeCall[] }
}
