# Changelog

## [0.2.0] - 2026-09-27

### Added

- **AI Q&A assistant** (Gemini): designate Q&A groups whose members ask the bot
  about activity in linked groups and communities by @mentioning it or replying
  to its messages. The bot answers from recorded data through a function-calling
  loop over five read-only tools (`group_list`, `group_members`, `group_messages`,
  `activity_stats`, `message_search`).
- Conversations: replying to a bot answer continues that exchange. The bot also
  sees the question group's recent messages (up to 20, max 48 hours) as context.
- Group and member references in answers render as tappable WhatsApp links.
- **Bot jobs**: every question becomes a persistent job with a full event trail
  (AI requests and responses, tool calls, token usage), browsable on the new
  **Bot jobs** pages. Jobs survive restarts and redeploys.
- Settings: Gemini API key (write-only), model, daily call limit, editable main
  system prompt with `{{timezone}}`/`{{botlid}}` placeholders, and an instance
  timezone used for every date the bot reads or writes.
- Group page: Bot card with a community-aware linked-scope picker and per-group
  additional instructions. Q&A badge on the dashboard and a **Resync** button.
- Full-text message search index covering texts, captions, poll questions and
  options, event names and descriptions, and attachment filenames.
- Member join/leave events are recorded as group activity (from live updates
  and roster syncs).
- Debug commands in Q&A groups, free of AI cost: `!tools` and `!tool <name> <json>`.

### Fixed

- Group renames and description changes now apply without a restart.
- Group-mention messages (wrapped by WhatsApp in an envelope) were recorded
  with empty text. They are now unwrapped and searchable.
- Membership rows no longer get a fabricated join date on roster syncs: join
  dates are stored only when the join was actually observed.
- Reaction changes and removals are resolved to each member's last reaction
  instead of counting stale ones as live.

### Notes

- Privacy: answering sends linked-group message content to Google's Gemini API.
  See the README's privacy note about free vs paid tier.

## [0.1.0]

Initial release: WhatsApp group activity monitor. Baileys connection, activity
recording (messages, edits, deletions, reactions, polls, events), web panel with
dashboard, group pages, backup/restore, and Railway deployment.
