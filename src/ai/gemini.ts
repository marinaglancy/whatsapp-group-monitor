import { GoogleGenAI } from '@google/genai'
import { AI_CALL_TIMEOUT_MS, type AiChatMessage, type AiProvider, type AiResponse, type AiToolDef } from './provider.js'

interface GeminiContent {
  role: 'user' | 'model'
  parts: Record<string, unknown>[]
}

interface GeminiTool {
  functionDeclarations: Record<string, unknown>[]
}

export interface GeminiResponseShape {
  text?: string
  functionCalls?: { name?: string; args?: Record<string, unknown> }[]
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
}

export function toGeminiContents(messages: AiChatMessage[]): GeminiContent[] {
  const contents: GeminiContent[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.text }] })
    } else if (m.role === 'assistant') {
      const parts: Record<string, unknown>[] = []
      if (m.text) parts.push({ text: m.text })
      for (const tc of m.toolCalls ?? []) parts.push({ functionCall: { name: tc.name, args: tc.args } })
      contents.push({ role: 'model', parts })
    } else {
      contents.push({ role: 'user', parts: [{ functionResponse: { name: m.name, response: { result: m.result } } }] })
    }
  }
  return contents
}

export function toGeminiTools(tools: AiToolDef[]): GeminiTool[] | undefined {
  if (!tools.length) return undefined
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      parametersJsonSchema: t.parameters,
      ...(t.responseJsonSchema ? { responseJsonSchema: t.responseJsonSchema } : {}),
    })),
  }]
}

export function fromGeminiResponse(resp: GeminiResponseShape): AiResponse {
  const toolCalls = (resp.functionCalls ?? [])
    .filter(fc => !!fc.name)
    .map(fc => ({ name: fc.name!, args: fc.args ?? {} }))
  return {
    text: resp.text || undefined,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    usage: {
      tokensIn: resp.usageMetadata?.promptTokenCount ?? 0,
      tokensOut: resp.usageMetadata?.candidatesTokenCount ?? 0,
    },
  }
}

export function createGeminiProvider(opts: { apiKey: string; model: string }): AiProvider {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey })
  return {
    async generate(req) {
      const response = await ai.models.generateContent({
        model: opts.model,
        contents: toGeminiContents(req.messages),
        config: {
          systemInstruction: req.system,
          abortSignal: AbortSignal.timeout(AI_CALL_TIMEOUT_MS),
          ...(req.tools.length ? { tools: toGeminiTools(req.tools) } : {}),
        },
      })
      return fromGeminiResponse(response as unknown as GeminiResponseShape)
    },
  }
}
