import { describe, it, expect } from 'vitest'
import { formatDateTime, parseDateTime } from '../../src/utils/time.js'

const LISBON = 'Europe/Lisbon'

describe('formatDateTime', () => {
  it('formats unix seconds and Dates in the given timezone', () => {
    const winterNoonUtc = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000
    expect(formatDateTime(winterNoonUtc, 'UTC')).toBe('2026-01-15 12:00:00')
    expect(formatDateTime(winterNoonUtc, LISBON)).toBe('2026-01-15 12:00:00') // winter: UTC+0
    expect(formatDateTime(new Date(Date.UTC(2026, 6, 15, 12, 0, 0)), LISBON)).toBe('2026-07-15 13:00:00') // summer: UTC+1
    expect(formatDateTime(winterNoonUtc, 'Europe/Helsinki')).toBe('2026-01-15 14:00:00')
  })
})

describe('parseDateTime', () => {
  it('roundtrips with formatDateTime across DST seasons', () => {
    for (const s of ['2026-01-15 12:00:00', '2026-07-15 13:30:45']) {
      const ts = parseDateTime(s, LISBON)
      expect(formatDateTime(ts, LISBON)).toBe(s)
    }
  })

  it('parses date-only with start/end edges', () => {
    expect(parseDateTime('2026-09-01', 'UTC', 'start')).toBe(Date.UTC(2026, 8, 1) / 1000)
    expect(parseDateTime('2026-09-30', 'UTC', 'end')).toBe(Date.UTC(2026, 8, 30, 23, 59, 59) / 1000)
    // edge default is start
    expect(parseDateTime('2026-09-01', 'UTC')).toBe(Date.UTC(2026, 8, 1) / 1000)
  })

  it('handles the nonexistent spring-forward hour without throwing', () => {
    // Lisbon 2026-03-29: 01:00 -> 02:00, so 01:30 local does not exist
    const ts = parseDateTime('2026-03-29 01:30:00', LISBON)
    expect(Math.abs(ts - Date.UTC(2026, 2, 29, 1, 30) / 1000)).toBeLessThanOrEqual(3600)
  })

  it('resolves the ambiguous fall-back hour deterministically to a valid occurrence', () => {
    // Lisbon 2026-10-25: 02:00 -> 01:00, so 01:30 local occurs twice (00:30Z and 01:30Z)
    const ts = parseDateTime('2026-10-25 01:30:00', LISBON)
    const valid = [Date.UTC(2026, 9, 25, 0, 30) / 1000, Date.UTC(2026, 9, 25, 1, 30) / 1000]
    expect(valid).toContain(ts)
    expect(parseDateTime('2026-10-25 01:30:00', LISBON)).toBe(ts) // deterministic
  })

  it('throws on malformed input and unknown timezones', () => {
    expect(() => parseDateTime('September 2026', 'UTC')).toThrow(TypeError)
    expect(() => parseDateTime('2026-13-01 00:00:00', 'UTC')).toThrow(TypeError)
    expect(() => parseDateTime('2026-02-31 10:00:00', 'UTC')).toThrow(TypeError) // impossible date must not roll over
    expect(() => parseDateTime('2026-09-01 25:00:00', 'UTC')).toThrow(TypeError)
    expect(() => parseDateTime('2026-09-01 12:00:00', 'Mars/Olympus')).toThrow(TypeError)
    expect(() => parseDateTime('1758900000', 'UTC')).toThrow(TypeError) // epoch numbers are never accepted
  })
})
