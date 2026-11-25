import type { ProcessableRecord } from '../whatsapp/activity/processor.js'

export interface GroupMessageEvent { kind: 'group_message'; record: ProcessableRecord }
export type TriggerEvent = GroupMessageEvent

export interface BaseTriggerConfig {
  onlyIfFirst: boolean
  waitSeconds: number
  maxAgeMinutes: number
  errorTemplate: string
}

export interface DispatchCtx { nowMs: number; botJids: string[] }

export interface TriggerCondition<C> {
  id: string
  check(event: TriggerEvent, config: C, ctx: DispatchCtx): boolean
}

export interface JobSpec {
  groupJid: string | null
  userJid: string | null
  messageId: string | null
  payload: Record<string, unknown>
}

export abstract class TriggerType<C extends BaseTriggerConfig = BaseTriggerConfig> {
  abstract readonly id: string
  abstract readonly displayName: string
  abstract readonly eventKind: TriggerEvent['kind']
  abstract readonly jobType: string
  /** Used when a trigger's own prompt is empty; shown on the trigger page. */
  abstract readonly defaultPrompt: string
  /** Used when a trigger's own error message is empty; shown on the trigger page. */
  abstract readonly defaultErrorTemplate: string
  readonly conditions: TriggerCondition<C>[] = []

  abstract defaults(): C

  /** defaults() overlaid with the stored keys that defaults() knows. */
  normalize(raw: Record<string, unknown> | null): C {
    const base = this.defaults()
    if (!raw) return base
    const out: Record<string, unknown> = { ...(base as object) }
    for (const key of Object.keys(base)) {
      if (key in raw && raw[key] !== undefined) out[key] = raw[key]
    }
    return out as unknown as C
  }

  abstract validate(
    raw: unknown,
    ctx: { coveredGroupJids: string[] },
  ): { ok: true; config: C } | { ok: false; error: string }

  /** One line for the tenant page. groupName turns a group jid into its name. */
  abstract summarize(config: C, groupName: (jid: string) => string): string

  /** A problem with the stored settings that the tenant page should show, or null. */
  warning(_config: C, _coveredGroupJids: string[]): string | null { return null }

  abstract watches(event: TriggerEvent, config: C): boolean
  abstract buildJob(event: TriggerEvent, config: C, ctx: DispatchCtx): JobSpec
}
