/** The one definition of what a row contributes to the full-text index.
 *  Shared by the index backfill, the insert trigger and the search snippet
 *  source so they can never drift apart.
 *
 *  Coverage per row type:
 *  - message/edit: the text or caption, plus a document attachment's filename
 *  - poll_create:  the question plus all option texts
 *  - event_create: the event name plus its description
 */
export const FTS_GENERATION = 2

export function ftsTextSqlExpr(prefix: string): string {
  const m = `${prefix}metadata`
  const r = `${prefix}raw`
  return `CASE ${prefix}event_type
    WHEN 'poll_create' THEN trim(
      coalesce(json_extract(${m}, '$.question'), '') || ' ' ||
      coalesce((SELECT group_concat(value, ' ') FROM json_each(${m}, '$.options')), ''))
    WHEN 'event_create' THEN trim(
      coalesce(json_extract(${m}, '$.name'), '') || ' ' ||
      coalesce(json_extract(${m}, '$.description'), ''))
    ELSE trim(
      coalesce(json_extract(${m}, '$.text'), '') || ' ' ||
      coalesce(json_extract(${r}, '$.message.documentMessage.fileName'), ''))
  END`
}

export const FTS_EVENT_TYPES = "('message', 'edit', 'poll_create', 'event_create')"
