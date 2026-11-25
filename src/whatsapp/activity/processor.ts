import type { ActivityEventType } from '../../db/schema.js'
import { dispatchEvent } from '../../triggers/dispatcher.js'
import { logger } from '../../utils/logger.js'

export interface ProcessableRecord {
  groupJid: string
  userJid: string
  messageId: string
  parentId: string | null
  eventType: ActivityEventType
  metadata: Record<string, unknown> | null
  timestamp: number
}

/** Process a single newly inserted activity record.
 *  Must never throw — the activity pipeline continues regardless. */
export function processRecord(record: ProcessableRecord): void {
  try {
    if (record.eventType === 'message') dispatchEvent({ kind: 'group_message', record })
  } catch (err) {
    logger.error({ err, groupJid: record.groupJid, messageId: record.messageId }, 'processRecord failed')
  }
}
