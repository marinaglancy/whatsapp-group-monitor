import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'crypto'
import { setupTestDbs } from '../helpers/db.js'
import { seedGroup, seedMessage } from '../helpers/fixtures.js'
import { handleHistorySync } from '../../src/whatsapp/handlers/history-sync.js'
import { setSetting } from '../../src/db/queries/settings.js'
import { updateBotUser } from '../../src/whatsapp/handlers/connection.js'
import { updateGroupQaConfig } from '../../src/db/queries/groups.js'
import { getAccountDb } from '../../src/db/account.js'
import { groupActivityLog, botJobs } from '../../src/db/schema.js'
import { logger } from '../../src/utils/logger.js'

let dbs: ReturnType<typeof setupTestDbs>
beforeEach(() => {
  dbs = setupTestDbs()
  seedGroup('g1@g.us', 'G1')
})
afterEach(() => { dbs.cleanup() })

// Shape seen in a real history sync (2026-11-02): group messages carry the
// sender in the top-level `participant`, never in key.participant, and no pushName.
function historyMsg(id: string, timestamp: number, over: Record<string, unknown> = {}) {
  return {
    key: { remoteJid: 'g1@g.us', fromMe: false, id },
    participant: 'u1@lid',
    messageTimestamp: timestamp,
    message: { conversation: `text ${id}` },
    ...over,
  }
}

function sync(messages: unknown[]) {
  handleHistorySync({ chats: [], contacts: [], messages, isLatest: false, progress: 100, syncType: 3 } as never)
}

function rows() {
  return getAccountDb().select().from(groupActivityLog).all()
    .map(r => ({ messageId: r.messageId, userJid: r.userJid, timestamp: r.timestamp }))
    .sort((a, b) => a.timestamp - b.timestamp)
}

describe('history sync import', () => {
  it('saves a message whose sender is only in the top-level participant', () => {
    seedMessage('g1@g.us', 'u0@lid', 'first live message', 1000, { messageId: 'LIVE1' })
    sync([historyMsg('H1', 1500)])
    const saved = getAccountDb().select().from(groupActivityLog).all().find(r => r.messageId === 'H1')
    expect(saved).toMatchObject({
      groupJid: 'g1@g.us',
      userJid: 'u1@lid',
      eventType: 'message',
      timestamp: 1500,
      metadata: { contentType: 'conversation', text: 'text H1' },
    })
  })

  it('by default only fills holes: skips messages older than the first recorded one in the group', () => {
    seedMessage('g1@g.us', 'u0@lid', 'first live message', 1000, { messageId: 'LIVE1' })
    sync([historyMsg('OLD', 999), historyMsg('SAME', 1000), historyMsg('NEW', 1500)])
    expect(rows().map(r => r.messageId)).toEqual(['LIVE1', 'SAME', 'NEW'])
  })

  it('by default saves nothing for a group with no recorded activity', () => {
    sync([historyMsg('H1', 1500)])
    expect(rows()).toEqual([])
  })

  it('saves older messages too when the setting is "all"', () => {
    setSetting('history_import', 'all')
    seedMessage('g1@g.us', 'u0@lid', 'first live message', 1000, { messageId: 'LIVE1' })
    sync([historyMsg('OLD', 500)])
    expect(rows().map(r => r.messageId)).toEqual(['OLD', 'LIVE1'])
  })

  it('skips groups the bot does not know', () => {
    setSetting('history_import', 'all')
    sync([historyMsg('H1', 1500, { key: { remoteJid: 'unknown@g.us', fromMe: false, id: 'H1' } })])
    expect(rows()).toEqual([])
  })

  it('skips messages whose sender is a phone ID, so one person is not stored under two IDs', () => {
    setSetting('history_import', 'all')
    sync([historyMsg('PN', 1500, { participant: '15550009999@s.whatsapp.net' }), historyMsg('LID', 1600)])
    expect(rows().map(r => r.messageId)).toEqual(['LID'])
  })

  it('saves own messages under the bot account, not under the participant ID', () => {
    setSetting('history_import', 'all')
    sync([historyMsg('MINE', 1500, {
      key: { remoteJid: 'g1@g.us', fromMe: true, id: 'MINE' },
      participant: '15550001234@s.whatsapp.net',
    })])
    // No socket in tests, so the record falls back to 'self' (same as live messages)
    expect(rows()).toEqual([{ messageId: 'MINE', userJid: 'self', timestamp: 1500 }])
  })

  it('saves own messages under the bot account when the key also has a phone ID (live key merged into history)', () => {
    setSetting('history_import', 'all')
    sync([historyMsg('MINE2', 1500, {
      key: {
        remoteJid: 'g1@g.us', fromMe: true, id: 'MINE2',
        participant: '98765432101234@lid', participantAlt: '15550001234@s.whatsapp.net',
      },
    })])
    expect(rows()).toEqual([{ messageId: 'MINE2', userJid: 'self', timestamp: 1500 }])
  })

  it('skips a message without a time instead of saving it in 1970', () => {
    setSetting('history_import', 'all')
    sync([historyMsg('NOTIME', 0, { messageTimestamp: undefined }), historyMsg('H1', 1500)])
    expect(rows().map(r => r.messageId)).toEqual(['H1'])
  })

  it('keeps the poll key that history stores outside the message, so later votes can be read', () => {
    setSetting('history_import', 'all')
    sync([historyMsg('POLL', 1500, {
      message: { pollCreationMessageV3: { name: 'Lunch?', options: [{ optionName: 'Yes' }, { optionName: 'No' }], selectableOptionsCount: 1 } },
      messageSecret: Uint8Array.from([1, 2, 3]),
    })])
    const saved = getAccountDb().select().from(groupActivityLog).all().find(r => r.messageId === 'POLL')
    expect(saved?.metadata).toEqual({ question: 'Lunch?', options: ['Yes', 'No'], encKey: 'AQID' })
  })

  it('does not save a message twice when it was already recorded live', () => {
    seedMessage('g1@g.us', 'u1@lid', 'text H1', 1500, { messageId: 'H1' })
    sync([historyMsg('H1', 1500)])
    expect(rows().map(r => r.messageId)).toEqual(['H1'])
  })

  it('never starts a Q&A answer, even for a recent question to the bot', () => {
    setSetting('history_import', 'all')
    updateBotUser({ id: '15550001234@s.whatsapp.net', lid: '98765432101234@lid' } as never)
    updateGroupQaConfig('g1@g.us', { enabled: true, linkedJids: [] })
    const now = Math.floor(Date.now() / 1000)
    sync([historyMsg('Q1', now - 5, {
      message: { extendedTextMessage: { text: 'how many?', contextInfo: { mentionedJid: ['98765432101234@lid'] } } },
    })])
    expect(rows().map(r => r.messageId)).toEqual(['Q1'])
    expect(getAccountDb().select().from(botJobs).all()).toEqual([])
  })
})

// Shapes seen in a real history sync (2026-11-02): each reaction and vote sits on the
// message it belongs to, has its own key with a lid participant, and a send time in ms.
// Votes are already decrypted: the chosen options are sha256 hashes of the option names.
function reaction(id: string, user: string, timestamp: number, text = '👍', over: Record<string, unknown> = {}) {
  return { key: { remoteJid: 'g1@g.us', fromMe: false, id, participant: user }, text, senderTimestampMs: timestamp * 1000, ...over }
}

function vote(id: string, user: string, timestamp: number, chosen: string[]) {
  return {
    pollUpdateMessageKey: { remoteJid: 'g1@g.us', fromMe: false, id, participant: user },
    vote: { selectedOptions: chosen.map(o => createHash('sha256').update(o).digest()) },
    senderTimestampMs: timestamp * 1000,
  }
}

// RSVPs are already decrypted too: 1 going, 2 not going, 3 maybe
function rsvp(id: string, user: string, timestamp: number, response: number) {
  return {
    eventResponseMessageKey: { remoteJid: 'g1@g.us', fromMe: false, id, participant: user },
    timestampMs: timestamp * 1000,
    eventResponseMessage: { response, timestampMs: timestamp * 1000 + 316 },
  }
}

const lunchPoll = { pollCreationMessageV3: { name: 'Lunch?', options: [{ optionName: 'Yes' }, { optionName: 'No' }], selectableOptionsCount: 1 } }
const picnic = { eventMessage: { name: 'Picnic', startTime: 5000 } }

function rowsOfType(eventType: string) {
  return getAccountDb().select().from(groupActivityLog).all()
    .filter(r => r.eventType === eventType)
    .map(r => ({ messageId: r.messageId, userJid: r.userJid, parentId: r.parentId, metadata: r.metadata, timestamp: r.timestamp }))
    .sort((a, b) => a.timestamp - b.timestamp)
}

describe('history sync import: reactions and votes', () => {
  beforeEach(() => {
    seedMessage('g1@g.us', 'u0@lid', 'first live message', 1000, { messageId: 'LIVE1' })
  })

  it('saves a reaction under its own ID, the person who reacted and the time it was sent', () => {
    sync([historyMsg('H1', 1500, { reactions: [reaction('R1', 'u2@lid', 1600, '😂')] })])
    expect(rowsOfType('reaction')).toEqual([
      { messageId: 'R1', userJid: 'u2@lid', parentId: 'H1', metadata: { emoji: '😂' }, timestamp: 1600 },
    ])
  })

  it('by default saves reactions on an older message when the reaction itself is not older than the first recorded activity', () => {
    sync([historyMsg('OLD', 900, { reactions: [reaction('R_OLD', 'u2@lid', 950), reaction('R_NEW', 'u3@lid', 1100)] })])
    expect(rowsOfType('reaction').map(r => r.messageId)).toEqual(['R_NEW'])
    expect(rows().map(r => r.messageId)).toEqual(['LIVE1', 'R_NEW'])
  })

  it('skips a reaction already recorded live, even when the phone clock was a little ahead', () => {
    seedMessage('g1@g.us', 'u2@lid', '', 1570, {
      eventType: 'reaction', messageId: 'reaction_LIVE1_u2@lid_1570', parentId: 'LIVE1', metadata: { emoji: '👍' },
    })
    sync([historyMsg('LIVE1', 1000, { participant: 'u0@lid', reactions: [reaction('R1', 'u2@lid', 1600), reaction('R2', 'u3@lid', 1600)] })])
    expect(rowsOfType('reaction').map(r => r.messageId)).toEqual(['reaction_LIVE1_u2@lid_1570', 'R2'])
  })

  it('saves a reaction that was changed after the live one was recorded', () => {
    seedMessage('g1@g.us', 'u2@lid', '', 1200, {
      eventType: 'reaction', messageId: 'reaction_LIVE1_u2@lid_1200', parentId: 'LIVE1', metadata: { emoji: '👍' },
    })
    sync([historyMsg('LIVE1', 1000, { participant: 'u0@lid', reactions: [reaction('R1', 'u2@lid', 5000, '❤️')] })])
    expect(rowsOfType('reaction').map(r => r.metadata)).toEqual([{ emoji: '👍' }, { emoji: '❤️' }])
  })

  it('does not save the same reaction twice when history arrives again', () => {
    const msg = historyMsg('H1', 1500, { reactions: [reaction('R1', 'u2@lid', 1600)] })
    sync([msg])
    sync([msg])
    expect(rowsOfType('reaction').map(r => r.messageId)).toEqual(['R1'])
  })

  it('skips reactions from a phone ID, so one person is not stored under two IDs', () => {
    sync([historyMsg('H1', 1500, { reactions: [reaction('R1', '15550009999@s.whatsapp.net', 1600), reaction('R2', 'u2@lid', 1600)] })])
    expect(rowsOfType('reaction').map(r => r.messageId)).toEqual(['R2'])
  })

  it('logs how many reactions, votes and RSVPs were already recorded', () => {
    seedMessage('g1@g.us', 'u2@lid', '', 1600, {
      eventType: 'reaction', messageId: 'reaction_LIVE1_u2@lid_1600', parentId: 'LIVE1', metadata: { emoji: '👍' },
    })
    seedMessage('g1@g.us', 'u3@lid', '', 1600, {
      eventType: 'poll_vote', messageId: 'V1', parentId: 'LIVE1', metadata: { selectedOptions: ['No'] },
    })
    seedMessage('g1@g.us', 'u4@lid', '', 1600, {
      eventType: 'event_response', messageId: 'E1', parentId: 'EVENT', metadata: { response: 'GOING' },
    })
    const info = vi.spyOn(logger, 'info')
    sync([
      historyMsg('LIVE1', 1000, {
        participant: 'u0@lid',
        message: lunchPoll,
        reactions: [reaction('R1', 'u2@lid', 1600)],
        pollUpdates: [vote('V1', 'u3@lid', 1600, ['No'])],
      }),
      historyMsg('EVENT', 1500, { message: picnic, eventResponses: [rsvp('E1', 'u4@lid', 1600, 1)] }),
    ])
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        reactions: 1, reactionsSaved: 0, reactionsAlreadyRecorded: 1,
        pollUpdates: 1, votesSaved: 0, votesAlreadyRecorded: 1,
        eventResponses: 1, eventResponsesSaved: 0, eventResponsesAlreadyRecorded: 1,
      }),
      'History sync saved',
    )
    info.mockRestore()
  })

  it('saves own reactions under the bot account', () => {
    sync([historyMsg('H1', 1500, {
      reactions: [reaction('R1', '15550001234@s.whatsapp.net', 1600, '👍', {
        key: { remoteJid: 'g1@g.us', fromMe: true, id: 'R1', participant: '15550001234@s.whatsapp.net' },
      })],
    })])
    // No socket in tests, so the record falls back to 'self' (same as own messages)
    expect(rowsOfType('reaction').map(r => r.userJid)).toEqual(['self'])
  })

  it('saves poll votes with the chosen option names, including a withdrawn vote', () => {
    sync([historyMsg('POLL', 1500, {
      message: lunchPoll,
      pollUpdates: [vote('V1', 'u2@lid', 1600, ['No']), vote('V2', 'u3@lid', 1700, [])],
    })])
    expect(rowsOfType('poll_vote')).toEqual([
      { messageId: 'V1', userJid: 'u2@lid', parentId: 'POLL', metadata: { selectedOptions: ['No'] }, timestamp: 1600 },
      { messageId: 'V2', userJid: 'u3@lid', parentId: 'POLL', metadata: { selectedOptions: [] }, timestamp: 1700 },
    ])
  })

  it('does not save a vote twice when it was already recorded live', () => {
    seedMessage('g1@g.us', 'u2@lid', '', 1600, {
      eventType: 'poll_vote', messageId: 'V1', parentId: 'POLL', metadata: { selectedOptions: ['No'] },
    })
    sync([historyMsg('POLL', 1500, {
      message: lunchPoll,
      pollUpdates: [vote('V1', 'u2@lid', 1600, ['No']), vote('V2', 'u3@lid', 1700, ['Yes'])],
    })])
    expect(rowsOfType('poll_vote').map(r => r.messageId)).toEqual(['V1', 'V2'])
  })

  it('by default skips votes older than the first recorded activity', () => {
    sync([historyMsg('OLD_POLL', 900, {
      message: lunchPoll,
      pollUpdates: [vote('V_OLD', 'u2@lid', 950, ['Yes']), vote('V_NEW', 'u3@lid', 1100, ['No'])],
    })])
    expect(rowsOfType('poll_vote').map(r => r.messageId)).toEqual(['V_NEW'])
  })

  it('saves event RSVPs with the answer, the person and the time', () => {
    sync([historyMsg('EVENT', 1500, {
      message: picnic,
      eventResponses: [rsvp('E1', 'u2@lid', 1600, 1), rsvp('E2', 'u3@lid', 1700, 2), rsvp('E3', 'u4@lid', 1800, 3)],
    })])
    expect(rowsOfType('event_response')).toEqual([
      { messageId: 'E1', userJid: 'u2@lid', parentId: 'EVENT', metadata: { response: 'GOING' }, timestamp: 1600 },
      { messageId: 'E2', userJid: 'u3@lid', parentId: 'EVENT', metadata: { response: 'NOT_GOING' }, timestamp: 1700 },
      { messageId: 'E3', userJid: 'u4@lid', parentId: 'EVENT', metadata: { response: 'MAYBE' }, timestamp: 1800 },
    ])
  })

  it('does not save an RSVP twice when it was already recorded live', () => {
    seedMessage('g1@g.us', 'u2@lid', '', 1600, {
      eventType: 'event_response', messageId: 'E1', parentId: 'EVENT', metadata: { response: 'GOING' },
    })
    sync([historyMsg('EVENT', 1500, {
      message: picnic,
      eventResponses: [rsvp('E1', 'u2@lid', 1600, 1), rsvp('E2', 'u3@lid', 1700, 3)],
    })])
    expect(rowsOfType('event_response').map(r => r.messageId)).toEqual(['E1', 'E2'])
  })

  it('takes the RSVP time from the outer record, or from the reply itself when that is missing', () => {
    sync([historyMsg('EVENT', 1500, {
      message: picnic,
      eventResponses: [
        { ...rsvp('E1', 'u2@lid', 1600, 1), timestampMs: undefined },
        { ...rsvp('E2', 'u3@lid', 1700, 1), eventResponseMessage: { response: 1, timestampMs: 1750 * 1000 } },
      ],
    })])
    expect(rowsOfType('event_response').map(r => [r.messageId, r.timestamp])).toEqual([['E1', 1600], ['E2', 1700]])
  })

  it('skips an RSVP without an answer, so it does not hide the person\'s earlier answer', () => {
    sync([historyMsg('EVENT', 1500, {
      message: picnic,
      eventResponses: [{ ...rsvp('E1', 'u2@lid', 1600, 1), eventResponseMessage: undefined }, rsvp('E2', 'u3@lid', 1600, 1)],
    })])
    expect(rowsOfType('event_response').map(r => r.messageId)).toEqual(['E2'])
  })

  it('by default skips RSVPs older than the first recorded activity', () => {
    sync([historyMsg('OLD_EVENT', 900, {
      message: picnic,
      eventResponses: [rsvp('E_OLD', 'u2@lid', 950, 1), rsvp('E_NEW', 'u3@lid', 1100, 1)],
    })])
    expect(rowsOfType('event_response').map(r => r.messageId)).toEqual(['E_NEW'])
  })
})
