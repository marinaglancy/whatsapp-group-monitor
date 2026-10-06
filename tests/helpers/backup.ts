import Database from 'better-sqlite3'

// groups schema as it was BEFORE the bot_config upgrade (real pre-upgrade backups)
export const OLD_GROUPS_DDL = `CREATE TABLE groups (
  jid TEXT PRIMARY KEY, name TEXT NOT NULL, is_community INTEGER NOT NULL DEFAULT 0,
  parent_community_jid TEXT, permissions TEXT, bot_membership TEXT NOT NULL DEFAULT 'none',
  bot_functions INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`

export const NEW_GROUPS_DDL = OLD_GROUPS_DDL.replace(
  'created_at INTEGER NOT NULL)',
  'created_at INTEGER NOT NULL, bot_config TEXT)',
)

// the other tables the merge touches, current shape. Every real backup has
// last_read_at: the backup feature arrived hours after that column.
export const SUPPORT_DDL = `
CREATE TABLE users (jid TEXT PRIMARY KEY, phone_number TEXT, is_banned INTEGER NOT NULL DEFAULT 0,
  display_name TEXT, display_name_updated_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE group_members (group_jid TEXT NOT NULL, user_jid TEXT NOT NULL, membership TEXT NOT NULL DEFAULT 'participant',
  joined_at INTEGER, left_at INTEGER, updated_at INTEGER NOT NULL, last_read_at TEXT, PRIMARY KEY (group_jid, user_jid));
CREATE TABLE group_activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, group_jid TEXT NOT NULL, user_jid TEXT NOT NULL,
  message_id TEXT NOT NULL, parent_id TEXT, event_type TEXT NOT NULL, metadata TEXT, raw TEXT, timestamp INTEGER NOT NULL, created_at INTEGER NOT NULL);
`

export function makeBackupDb(path: string, groupsDdl: string, inserts: string): void {
  const db = new Database(path)
  db.exec(groupsDdl)
  db.exec(SUPPORT_DDL)
  db.exec(inserts)
  db.close()
}

/** A backup from before the bot existed (no bot_config, no bot tables, no
 *  search index): one group, one member, and one message containing `word`. */
export function makePreBotBackup(path: string, word: string): void {
  makeBackupDb(path, OLD_GROUPS_DDL, `
    INSERT INTO groups (jid, name, is_community, bot_membership, bot_functions, is_archived, created_at)
      VALUES ('old@g.us', 'Old Group', 0, 'participant', 0, 0, 1700000000000);
    INSERT INTO users (jid, phone_number, is_banned, display_name, created_at, updated_at)
      VALUES ('old-user@lid', '351900000001', 0, 'Olga', 1700000000000, 1700000000000);
    INSERT INTO group_members (group_jid, user_jid, membership, joined_at, updated_at)
      VALUES ('old@g.us', 'old-user@lid', 'participant', 1700000000000, 1700000000000);
    INSERT INTO group_activity_log (group_jid, user_jid, message_id, event_type, metadata, timestamp, created_at)
      VALUES ('old@g.us', 'old-user@lid', 'OLDMSG1', 'message',
              '{"contentType":"conversation","text":"see you at the ${word} tomorrow"}', 1700000000, 1700000000000);`)
}
