/** Thin provider interface the responder talks to; Gemini is the sole implementation. */

export const AI_CALL_TIMEOUT_MS = 30_000

/** Matches ToolDeclaration from tools/loader.ts — the model-ready wire format. */
export interface AiToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  responseJsonSchema?: Record<string, unknown>
}

export interface AiToolCall {
  name: string
  args: Record<string, unknown>
}

export type AiChatMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text?: string; toolCalls?: AiToolCall[] }
  | { role: 'tool'; name: string; result: string }

export interface AiUsage {
  tokensIn: number
  tokensOut: number
}

export interface AiResponse {
  text?: string
  toolCalls?: AiToolCall[]
  usage: AiUsage
}

export interface AiProvider {
  generate(req: { system: string; messages: AiChatMessage[]; tools: AiToolDef[] }): Promise<AiResponse>
}
