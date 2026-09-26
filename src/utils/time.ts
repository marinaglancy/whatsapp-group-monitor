/** The single boundary between epoch time and the model-visible local
 *  'YYYY-MM-DD HH:MM:SS' representation. Nothing above this layer may pass
 *  epoch numbers to the model or accept them from it. */

const DT_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/

function dtf(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
}

/** Format a Date or unix-seconds timestamp as 'YYYY-MM-DD HH:MM:SS' in the timezone. */
export function formatDateTime(d: Date | number, timeZone: string): string {
  const date = typeof d === 'number' ? new Date(d * 1000) : d
  // sv-SE yields '2026-01-15 12:00:00' (with a narrow space variant in some ICU builds)
  return dtf(timeZone).format(date).replace(' ', ' ').replace('T', ' ')
}

/** What wall-clock time (as a UTC-parts timestamp) the given epoch shows in the timezone. */
function wallClockUtcMs(epochMs: number, timeZone: string): number {
  const parts = dtf(timeZone).formatToParts(new Date(epochMs))
  const get = (type: string) => Number(parts.find(p => p.type === type)!.value)
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
}

/** Parse 'YYYY-MM-DD HH:MM[:SS]' (or date-only) in the timezone into unix seconds.
 *  Date-only input resolves to 00:00:00 (edge 'start') or 23:59:59 (edge 'end').
 *  DST-aware via a two-pass correction; ambiguous fall-back times resolve
 *  deterministically. Throws TypeError on malformed input or unknown timezone. */
export function parseDateTime(s: string, timeZone: string, edge: 'start' | 'end' = 'start'): number {
  const m = DT_RE.exec(s.trim())
  if (!m) throw new TypeError(`Invalid datetime '${s}': expected 'YYYY-MM-DD HH:MM:SS'`)
  const [, y, mo, d, h, mi, se] = m
  const hasTime = h !== undefined
  const H = hasTime ? Number(h) : (edge === 'end' ? 23 : 0)
  const MI = hasTime ? Number(mi) : (edge === 'end' ? 59 : 0)
  const SE = hasTime ? (se !== undefined ? Number(se) : 0) : (edge === 'end' ? 59 : 0)
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31 || H > 23 || MI > 59 || SE > 59) {
    throw new TypeError(`Invalid datetime '${s}'`)
  }
  let zoneOk = true
  try {
    dtf(timeZone)
  } catch {
    zoneOk = false
  }
  if (!zoneOk) throw new TypeError(`Unknown timezone '${timeZone}'`)

  const target = Date.UTC(Number(y), Number(mo) - 1, Number(d), H, MI, SE)
  let guess = target
  for (let i = 0; i < 2; i++) {
    guess = guess - (wallClockUtcMs(guess, timeZone) - target)
  }
  return Math.floor(guess / 1000)
}
