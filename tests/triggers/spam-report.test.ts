import { describe, it, expect } from 'vitest'
import { normalizeText, spammerReport, suspiciousReport } from '../../src/triggers/spam/report.js'
import { SPAM_ANSWER_SPEC } from '../../src/triggers/spam/answer.js'

const U = '123@lid'
describe('normalizeText', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeText('  a \n\t b   c  ')).toBe('a b c')
  })
})

describe('spammerReport', () => {
  it('has both sections and a removal line', () => {
    expect(spammerReport({ userJid: U, contents: 'Buy now', notDeleted: ['1@g.us', '2@g.us'], deleted: ['3@g.us'], removal: 'User removed from the community' }))
      .toBe('Detected spam by user @123:\n\n*Not deleted!*\n- group @1\n- group @2\n\n*Deleted messages:*\n- group @3\n\nUser removed from the community\n\n*Deleted message contents:*\nBuy now')
  })
  it('has only not-deleted and no removal line', () => {
    expect(spammerReport({ userJid: U, contents: 'x', notDeleted: ['1@g.us'], deleted: [] }))
      .toBe('Detected spam by user @123:\n\n*Not deleted!*\n- group @1\n\n*Deleted message contents:*\nx')
  })
  it('keeps line breaks in the contents', () => {
    expect(spammerReport({ userJid: U, contents: 'a\n\nb', notDeleted: ['1@g.us'], deleted: [] }))
      .toContain('*Deleted message contents:*\na\n\nb')
  })
})

describe('suspiciousReport', () => {
  it('has both sections and the text', () => {
    expect(suspiciousReport({ userJid: U, contents: 'Ad\nline', notDeleted: ['1@g.us'], deleted: ['2@g.us'] }))
      .toBe('Suspicious message by user @123\n\n*Not deleted:*\n- group @1\n\n*Deleted:*\n- group @2\n\nAd\nline')
  })
  it('omits empty sections', () => {
    expect(suspiciousReport({ userJid: U, contents: 'Ad', notDeleted: [], deleted: ['2@g.us'] }))
      .toBe('Suspicious message by user @123\n\n*Deleted:*\n- group @2\n\nAd')
  })
})

describe('SPAM_ANSWER_SPEC', () => {
  it('accepts a verdict and an error', () => {
    expect(SPAM_ANSWER_SPEC.validate({ error: false, isspam: true, isspammer: false, reason: 'ad' })).not.toBeNull()
    expect(SPAM_ANSWER_SPEC.validate({ error: true, errormessage: 'x' })).not.toBeNull()
    expect(SPAM_ANSWER_SPEC.validate({ error: false, isspam: true })).toBeNull()
  })
})
