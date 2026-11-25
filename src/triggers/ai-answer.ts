import { Ajv } from 'ajv'

/** Every AI trigger answers with JSON of this base shape plus its own fields. */
export interface AiAnswerBase { error: boolean; errormessage?: string }

export interface AnswerSpec<T extends AiAnswerBase> {
  /** JSON schema sent to the provider (JSON mode). */
  modelSchema: Record<string, unknown>
  /** Prompt text telling the AI the answer format. */
  formatSection: string
  /** The parsed value as T, or null when it does not fit. */
  validate(v: unknown): T | null
}

/** Whether the schema is sent on rounds that also offer tools. Verified live on
 *  2026-11-25: the configured Gemini model accepts tools together with a JSON
 *  response schema (tests/ai/gemini-live.test.ts). */
export const SEND_ANSWER_SCHEMA_WITH_TOOLS = true

const ajv = new Ajv({ strict: false })

export function buildAnswerSpec<T extends AiAnswerBase>(
  okProps: Record<string, Record<string, unknown>>,
  formatSection: string,
): AnswerSpec<T> {
  const properties = { error: { type: 'boolean' }, errormessage: { type: 'string' }, ...okProps }
  // The model must always send the extra fields, so JSON mode cannot return {"error":false} alone.
  const modelSchema = { type: 'object', properties, required: ['error', ...Object.keys(okProps)] }
  // Our own check is looser: the extra fields are only required when error is false.
  const checkSchema = {
    type: 'object',
    properties,
    required: ['error'],
    if: { properties: { error: { const: false } } },
    then: { required: Object.keys(okProps) },
  }
  const check = ajv.compile(checkSchema)
  return {
    modelSchema,
    formatSection,
    validate: v => (check(v) ? (v as unknown as T) : null),
  }
}

/** Parse the AI's text as the spec's JSON answer; null when it is not one.
 *  One surrounding ```json fence is accepted. */
export function parseAiAnswer<T extends AiAnswerBase>(text: string | undefined, spec: AnswerSpec<T>): T | null {
  if (!text) return null
  let body = text.trim()
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/i.exec(body)
  if (fence) body = fence[1].trim()
  try {
    return spec.validate(JSON.parse(body))
  } catch {
    return null
  }
}
