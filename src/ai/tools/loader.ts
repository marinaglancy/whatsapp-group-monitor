import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { expandPlaceholders } from '../settings.js'

/** A tool declaration as sent to the model (Gemini wire format). */
export interface ToolDeclaration {
  name: string
  description: string
  parameters: Record<string, unknown>
  responseJsonSchema: Record<string, unknown>
}

const __dirname = dirname(fileURLToPath(import.meta.url))

let cache: ToolDeclaration[] | null = null

/** The declarations exactly as authored in qa-tools.json (including _-metadata). */
export function rawToolDeclarations(): (ToolDeclaration & Record<string, unknown>)[] {
  if (!cache) {
    cache = JSON.parse(readFileSync(join(__dirname, 'qa-tools.json'), 'utf8')) as ToolDeclaration[]
  }
  return cache as (ToolDeclaration & Record<string, unknown>)[]
}

function transform(node: unknown, values: Record<string, string>): unknown {
  if (typeof node === 'string') return expandPlaceholders(node, values)
  if (Array.isArray(node)) return node.map(n => transform(n, values))
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('_')) continue // metadata never reaches the model
      out[k] = transform(v, values)
    }
    return out
  }
  return node
}

/** Model-ready declarations: _-metadata stripped, {{placeholders}} expanded. */
export function loadToolDeclarations(values: Record<string, string>): ToolDeclaration[] {
  return rawToolDeclarations().map(t => transform(t, values) as ToolDeclaration)
}
