import { LRUCache } from 'lru-cache'

export const SENT_LRU_MAX = 500

const sent = new LRUCache<string, true>({ max: SENT_LRU_MAX })

/** Remember a message id that THIS process sent (so the trigger never answers itself).
 *  Deliberately not fromMe-based: the account owner's own phone messages are fromMe too. */
export function registerSentMessage(id: string): void {
  sent.set(id, true)
}

export function wasSentByBot(id: string): boolean {
  return sent.has(id)
}
