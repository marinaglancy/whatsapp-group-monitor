import type { TriggerType } from './types.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTriggerType = TriggerType<any>

const types = new Map<string, AnyTriggerType>()

export function registerTriggerType(t: AnyTriggerType): void {
  types.set(t.id, t)
}

export function getTriggerType(id: string): AnyTriggerType | null {
  return types.get(id) ?? null
}

export function listTriggerTypes(): AnyTriggerType[] {
  return [...types.values()]
}

export function clearTriggerTypesForTests(): void {
  types.clear()
}
