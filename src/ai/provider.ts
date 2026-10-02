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
  /** `raw` is the provider's own content for this turn, echoed back verbatim
   *  in history — Gemini function calls carry thought signatures that must
   *  survive the round-trip. Opaque outside the provider. */
  | { role: 'assistant'; text?: string; toolCalls?: AiToolCall[]; raw?: unknown }
  | { role: 'tool'; name: string; result: string }

export interface AiUsage {
  tokensIn: number
  tokensOut: number
}

export interface AiResponse {
  text?: string
  toolCalls?: AiToolCall[]
  usage: AiUsage
  /** Provider-native content of this turn; pass back on the next assistant message. */
  raw?: unknown
}

export interface AiRequest {
  system: string
  messages: AiChatMessage[]
  tools: AiToolDef[]
  /** false = the model must answer in text. The tools stay declared, because
   *  the history may still hold earlier calls to them. Default true. */
  allowToolCalls?: boolean
}

export interface AiProvider {
  generate(req: AiRequest): Promise<AiResponse>
}
