import { registerTriggerType } from './registry.js'
import { qaTriggerType } from './qa/type.js'
import { spamTriggerType } from './spam/type.js'

/** Register every built-in trigger type. Safe to call more than once. */
export function registerBuiltinTriggerTypes(): void {
  registerTriggerType(qaTriggerType)
  registerTriggerType(spamTriggerType)
}
