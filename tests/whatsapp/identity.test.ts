import { describe, it, expect } from 'vitest'
import { updateBotUser, getBotJids } from '../../src/whatsapp/handlers/connection.js'

describe('bot identity', () => {
  it('normalizes and exposes jid and lid', () => {
    updateBotUser({ id: '15550001234:12@s.whatsapp.net', lid: '98765432101234:2@lid', notify: 'Bot' } as never)
    expect(getBotJids()).toEqual(['15550001234@s.whatsapp.net', '98765432101234@lid'])
  })

  it('keeps previous identity fields when an update omits them', () => {
    updateBotUser({ id: '15550001234@s.whatsapp.net', lid: '98765432101234@lid' } as never)
    updateBotUser({ id: '15550001234@s.whatsapp.net' } as never)
    expect(getBotJids()).toContain('98765432101234@lid')
  })
})
