import { describe, it, expect } from 'vitest'
import { TriggerJobError, ERROR_TEXT, errorTextFor, renderErrorTemplate } from '../../src/triggers/errors.js'

describe('errorTextFor', () => {
  it('uses the text of a TriggerJobError', () => {
    expect(errorTextFor(new TriggerJobError(ERROR_TEXT.noApiKey), 'whatever')).toBe(ERROR_TEXT.noApiKey)
  })

  it('cuts an overlong AI error message to 500 characters (Review Focus 5)', () => {
    expect(errorTextFor(new TriggerJobError('x'.repeat(900)), '')).toHaveLength(500)
  })

  it('maps 429-ish errors to the busy text, ignoring line numbers in stack frames', () => {
    expect(errorTextFor(new Error('x'), '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}')).toBe(ERROR_TEXT.busy)
    expect(errorTextFor(new Error('x'), 'Error: boom\n    at foo (/app/x.js:429:12)')).toBe(ERROR_TEXT.generic)
  })

  it('falls back to the generic text', () => {
    expect(errorTextFor(new Error('x'), 'Error: boom')).toBe(ERROR_TEXT.generic)
  })

  it('has the exact texts', () => {
    expect(ERROR_TEXT.dailyLimit(50)).toBe('the daily AI usage limit (50 calls) is reached')
    expect(ERROR_TEXT.busy).toBe('the AI service is busy right now, please try again in a minute')
    expect(ERROR_TEXT.noApiKey).toBe('the AI is not set up yet (API key missing)')
    expect(ERROR_TEXT.noOtherGroups).toBe('no other groups are in this tenant yet')
    expect(ERROR_TEXT.invalidAnswer).toBe('the AI did not return a valid answer')
    expect(ERROR_TEXT.aiCouldNotAnswer).toBe('the AI could not answer')
    expect(ERROR_TEXT.generic).toBe('something went wrong; details are in the admin panel job log')
  })
})

describe('renderErrorTemplate', () => {
  it('renders the template placeholders and leaves unknown ones', () => {
    const v = { error: 'E', trigger: 'T', group: 'G', user: 'U', message: 'M' }
    expect(renderErrorTemplate('⚠️ {{error}} / {{trigger}} / {{group}} / {{user}} / {{message}} / {{other}}', v))
      .toBe('⚠️ E / T / G / U / M / {{other}}')
  })
})
