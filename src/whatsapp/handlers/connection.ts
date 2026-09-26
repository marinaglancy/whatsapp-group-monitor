import { jidNormalizedUser } from 'baileys'
import type { ConnectionState, Contact } from 'baileys'
import { logger } from '../../utils/logger.js'
import { initAccountDb, closeAccountDb } from '../../db/account.js'

let currentQr: string | null = null
let connectionState: string | null = null
let botUser: { name: string | null; phone: string | null; jid: string | null; lid: string | null } | null = null

export function getCurrentQr() { return currentQr }
export function getConnectionState() { return connectionState }
export function getBotUser() { return botUser }

export function handleConnectionUpdate(update: Partial<ConnectionState>, user?: Contact | null) {
  if (update.qr) {
    currentQr = update.qr
    logger.debug('New QR code generated')
  }

  if (update.connection) {
    connectionState = update.connection
    if (update.connection === 'open') {
      currentQr = null
      const phone = user?.id?.split(':')[0].split('@')[0] || null
      const name = user?.name || user?.notify || null
      const lidRaw = (user as { lid?: string } | null | undefined)?.lid
      botUser = {
        name,
        phone,
        jid: user?.id ? jidNormalizedUser(user.id) : null,
        lid: lidRaw ? jidNormalizedUser(lidRaw) : null,
      }
      if (phone) {
        initAccountDb(phone)
      }
      logger.info({ phone }, 'WhatsApp connection established')
    } else if (update.connection === 'close') {
      botUser = null
      closeAccountDb()
    }
  }
}

export function updateBotUser(user?: Contact | null) {
  if (!user) return
  const phone = user.id?.split(':')[0].split('@')[0] || botUser?.phone || null
  const name = user.name || user.notify || botUser?.name || null
  const lidRaw = (user as { lid?: string }).lid
  botUser = {
    name,
    phone,
    jid: user.id ? jidNormalizedUser(user.id) : botUser?.jid ?? null,
    lid: lidRaw ? jidNormalizedUser(lidRaw) : botUser?.lid ?? null,
  }
}

/** Normalized jids identifying the bot account (phone jid and lid). Empty when not connected. */
export function getBotJids(): string[] {
  if (!botUser) return []
  return [botUser.jid, botUser.lid].filter((j): j is string => !!j)
}
