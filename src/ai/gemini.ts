import { FunctionCallingConfigMode, GoogleGenAI } from '@google/genai'
import { AI_CALL_TIMEOUT_MS, type AiChatMessage, type AiProvider, type AiRequest, type AiResponse, type AiToolDef } from './provider.js'

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
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.text }] })
    } else if (m.role === 'assistant') {
      // Prefer the provider's own content: Gemini functionCall parts carry
      // thought signatures the API requires back verbatim (400 otherwise).
      if (m.raw && typeof m.raw === 'object') {
        contents.push(m.raw as GeminiContent)
        continue
      }
      const parts: Record<string, unknown>[] = []
      if (m.text) parts.push({ text: m.text })
      for (const tc of m.toolCalls ?? []) parts.push({ functionCall: { name: tc.name, args: tc.args } })
      contents.push({ role: 'model', parts })
    } else {
      // All results answering one model turn must arrive as ONE user content
      // with a functionResponse part per call, in call order.
      const parts: Record<string, unknown>[] = []
      while (i < messages.length && messages[i].role === 'tool') {
        const t = messages[i] as Extract<AiChatMessage, { role: 'tool' }>
        parts.push({ functionResponse: { name: t.name, response: { result: t.result } } })
        i++
      }
      i--
      contents.push({ role: 'user', parts })
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

export interface GeminiConfig {
  systemInstruction: string
  tools?: GeminiTool[]
  toolConfig?: { functionCallingConfig: { mode: FunctionCallingConfigMode } }
}

export function toGeminiConfig(req: AiRequest): GeminiConfig {
  const tools = toGeminiTools(req.tools)
  return {
    systemInstruction: req.system,
    ...(tools ? { tools } : {}),
    ...(tools && req.allowToolCalls === false
      ? { toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } } }
      : {}),
  }
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
        config: { ...toGeminiConfig(req), abortSignal: AbortSignal.timeout(AI_CALL_TIMEOUT_MS) },
      })
      // Read functionCalls first: the .text getter warns to the console when
      // the response mixes text and functionCall parts.
      const functionCalls = response.functionCalls
      const mapped = fromGeminiResponse({
        text: functionCalls?.length ? undefined : response.text,
        functionCalls,
        usageMetadata: response.usageMetadata,
      })
      const rawContent = response.candidates?.[0]?.content
      return rawContent ? { ...mapped, raw: rawContent } : mapped
    },
  }
}
