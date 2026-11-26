import { getMembership, isAdminLevel } from '../db/queries/members.js'
import { countUserMessagesBefore } from '../db/queries/activity.js'
import type { TriggerCondition } from './types.js'

/** Passes when the sender is not an admin of the group (or the setting is off). */
export function senderNotAdmin<C>(on: (c: C) => boolean): TriggerCondition<C> {
  return {
    id: 'sender_not_admin',
    check(event, config) {
      if (!on(config)) return true
      const m = getMembership(event.record.groupJid, event.record.userJid)
      return !isAdminLevel(m?.membership)
    },
  }
}

/** Passes when the sender joined the group within the last N days. An unknown join date means an old member. */
export function joinedWithinDays<C>(days: (c: C) => number | null): TriggerCondition<C> {
  return {
    id: 'joined_within_days',
    check(event, config, ctx) {
      const n = days(config)
      if (n === null) return true
      const joinedAt = getMembership(event.record.groupJid, event.record.userJid)?.joinedAt
      if (!joinedAt) return false
      return ctx.nowMs - joinedAt.getTime() <= n * 86_400_000
    },
  }
}

/** Passes when the sender had posted fewer than N messages in the group before this one. */
export function fewerMessagesThan<C>(n: (c: C) => number | null): TriggerCondition<C> {
  return {
    id: 'fewer_messages_than',
    check(event, config) {
      const max = n(config)
      if (max === null) return true
      const { groupJid, userJid, timestamp } = event.record
      return countUserMessagesBefore(groupJid, userJid, timestamp) < max
    },
  }
}
