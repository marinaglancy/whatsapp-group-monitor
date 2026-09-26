import { describe, it, expect } from 'vitest'
import type { WAMessage } from 'baileys'
import { ActivityRecord } from '../../src/whatsapp/activity/record.js'

function makeMsg(message: Record<string, unknown>): WAMessage {
  return {
    key: { remoteJid: 'g1@g.us', id: 'M1', participant: '15551112222:3@s.whatsapp.net', fromMe: false },
    message,
    messageTimestamp: 1_800_000_000,
  } as unknown as WAMessage
}

describe('mention capture', () => {
  it('captures normalized mentions from extended text messages', () => {
    const rec = ActivityRecord.fromMessage(makeMsg({
      extendedTextMessage: {
        text: '@bot how many messages?',
        contextInfo: { mentionedJid: ['15550001234:9@s.whatsapp.net'] },
      },
    }), 'g1@g.us')!
    expect(rec.metadata!.mentions).toEqual(['15550001234@s.whatsapp.net'])
    expect(rec.metadata!.text).toBe('@bot how many messages?')
  })

  it('captures mentions from media captions', () => {
    const rec = ActivityRecord.fromMessage(makeMsg({
      imageMessage: { caption: 'look @bot', contextInfo: { mentionedJid: ['1@lid', '2@lid'] } },
    }), 'g1@g.us')!
    expect(rec.metadata!.mentions).toEqual(['1@lid', '2@lid'])
  })

  it('omits the mentions key entirely when there are none', () => {
    const rec = ActivityRecord.fromMessage(makeMsg({ conversation: 'plain text' }), 'g1@g.us')!
    expect('mentions' in rec.metadata!).toBe(false)
  })

  it('unwraps groupMentionedMessage envelopes (real clients wrap group mentions)', () => {
    const rec = ActivityRecord.fromMessage(makeMsg({
      groupMentionedMessage: {
        message: {
          extendedTextMessage: {
            text: 'events are in @120363276236119239@g.us this week',
            contextInfo: {
              mentionedJid: ['5@lid'],
              groupMentions: [{ groupJid: '120363276236119239@g.us', groupSubject: 'Hiking' }],
            },
          },
        },
      },
    }), 'g1@g.us')!
    expect(rec.metadata!.text).toBe('events are in @120363276236119239@g.us this week')
    expect(rec.metadata!.contentType).toBe('extendedTextMessage')
    expect(rec.metadata!.mentions).toEqual(['5@lid'])
  })
})
