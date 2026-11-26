# WhatsApp Group Monitor

Self-hosted WhatsApp group activity monitor. Tracks group members, messages, reactions, polls, and events via a web dashboard.

## WhatsApp Account

This tool uses [Baileys](https://github.com/WhiskeySockets/Baileys), an open-source library that connects to WhatsApp as a linked device. No WhatsApp Business account or API subscription is needed — a regular WhatsApp account works.

You can use your own WhatsApp account or a dedicated one. The monitor connects as a linked device and passively tracks group activity without interfering with normal use.

If the service restarts, it automatically catches up on messages it missed while offline. If you disconnect (unlink the device) and re-connect, WhatsApp sends a copy of the recent chat history, and the monitor uses it to fill the gap: messages, reactions, poll votes and event RSVPs. Messages deleted in the meantime cannot be recovered. A setting chooses whether to only fill such gaps or to save all the history WhatsApp sends.

## Deployment

### Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/whatsapp-group-monitor?referralCode=5IPNhU&utm_medium=integration&utm_source=template&utm_campaign=generic)

Click the button above to deploy. The template sets up the volume and exposes HTTPS automatically. You only need to set `ADMIN_PASSWORD` during setup.

Once deployed, navigate to the service Settings page on Railway and copy the URL from Public Networking. You can also change the region if you wish.

[![Railway Settings](pix/railway-settings-thumb.png)](pix/railway-settings.png)

### Docker

```bash
cp .env.example .env
# Edit .env: set ADMIN_PASSWORD
cp docker-compose.example.yml docker-compose.yml
# Edit docker-compose.yml if needed (e.g. the port)
docker compose up --build
```

Data is persisted in a named Docker volume.

### Local

Requires Node.js 22+ and npm.

```bash
npm install
cp .env.example .env
# Edit .env: set ADMIN_PASSWORD
npm run dev
```

Access at http://localhost:3000 (or another port indicated in `.env`).

## Getting Started

1. Open the web panel and log in
2. Scan the QR code with WhatsApp (Linked Devices > Link a Device)
3. The dashboard shows all groups the account is in, with member counts and activity stats

## Tenants and triggers

Bot features are organised in **tenants**. A tenant is a set of WhatsApp groups and/or
communities, plus the **triggers** that act on activity in them. A community entry covers
all its groups, including ones added later. A group belongs to at most one tenant (directly
or through its community). Groups that are in no tenant are still monitored; they just have
no triggers. The front page shows each group's tenant.

Each trigger has a name, an on/off switch and a place in the run order. Triggers run top to
bottom, and you can drag them to reorder. A trigger can be set to run only if no earlier
trigger fired for the same event.

There are two trigger types: **Mentions** and **Spam** (see [Spam trigger](#spam-trigger) below).

**Mentions** is the AI Q&A assistant, which answers when someone @mentions the bot or replies to it. Members of one
chosen group (the Q&A group) can ask the bot questions about activity in the other groups of
the tenant: message counts, conversation summaries, most/least active members, poll
attendance.

Setup:

1. Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/) and enter
   it on the **Settings** page. The model, a daily call limit and the timezone used for all
   dates are configurable there too.
2. Open the **Tenants** page (in the ⋮ menu) and click **+ New tenant**. Give it a name,
   then use **Change...** to choose its communities and groups. A group already used by
   another tenant is greyed out.
3. Click **+ Add trigger** and choose **Mentions**. Choose its **Q&A group**, which must be
   one of the tenant's groups, and save.
4. Members of the Q&A group talk to the bot by **@mentioning** the connected account
   or **replying** to one of its messages. Replying to an answer continues that
   conversation: the bot re-reads the earlier exchange. It also sees the group's
   recent messages (up to 20, at most 48 hours old) as context.

On the trigger page you can also set:

- **Timing**: how many seconds to wait before answering, and how old a message may be
  (in minutes) before it is ignored.
- **Prompt**: the main system prompt of this trigger. Empty means the default prompt
  (**Show default** displays it). Placeholders: `{{timezone}}`, `{{botlid}}`.
- **Additional instructions**: extra text added after the prompt, for example to set the
  bot's tone or language.
- **Error message**: what the bot posts when it cannot answer. Empty means the default,
  `⚠️ Sorry, I could not answer: {{error}}`.

If you used an earlier version with Q&A groups, they are converted to tenants
automatically on the first start of this version: one tenant per Q&A group, holding that
group and its linked groups, with one Mentions trigger named "Q&A" carrying the old
instructions (and the old main prompt, if you had changed it). The trigger stays switched
off if Q&A was off for that group. A group already taken by an earlier tenant is left out
of the later one (a warning is logged).

Every question becomes a **job**; see the **Bot jobs** page (linked from the status
bar) for status, the full AI interaction trail, token usage and the trigger that created
it. Answers are based only on activity this monitor has recorded; the bot cannot see
history from before it was connected (except what WhatsApp's history sync provided).

For debugging, two commands answer without calling the AI: `@bot !tools` lists the
data tools, and `@bot !tool <name> <json-args>` runs one and echoes its raw result.

### How the AI integration works

A question is answered by a **function-calling loop** against Google's Gemini API
(`@google/genai`): the model receives the system prompt, the recent conversation of
the group the question was asked in, and the question, then decides which data tools
to call, reads their results, and writes the final answer (up to 8 rounds within a
60 s budget). The last round sends no tools, only the results gathered so far, so the
model has to answer. The model must reply with a JSON answer: either
`{"error": false, "output": "..."}` with the text to post, or
`{"error": true, "errormessage": "..."}` when it cannot answer. If the AI still has no
valid answer on the last round, the job fails and the error message is posted.
When a job fails for good (for example the AI is busy, the daily limit is reached, no API
key is set, or the AI reports an error), the trigger's **error message** is posted as a
reply, with `{{error}}` replaced by a short plain reason. Temporary errors are retried
once first. Technical details stay in the job log.
The tools are read-only queries over this monitor's own database:

| Tool             | Returns                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `group_list`     | The groups in scope, with optional details (member count, bot role, last activity, …)                                                             |
| `group_members`  | Members of a group with roles, names, join dates and activity counts                                                                              |
| `group_messages` | Messages as participants see them: final edited text, polls with votes, events with responses, reactions, media indications                       |
| `activity_stats` | Aggregated counts per group and period: messages, edits, reactions, votes, plus contributor/engager/participant member numbers                    |
| `message_search` | Full-text search (messages, captions, poll questions/options, event names, attachment filenames); can also find links, media and deleted messages |

The tools only ever see the tenant's groups (enforced server-side;
the model cannot widen its own scope), all dates use the configured timezone, and
oversized results are paged. Message _content_ the model reads it can quote; media
files, voice messages and images are never sent, only an indication of their type.
Every request, response, tool call and token count is logged to the job's event
timeline in the web panel.

### Placeholders

These tokens are replaced before any text reaches the model. They work in a trigger's
**prompt** and **additional instructions**:

| Placeholder    | Replaced with                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `{{timezone}}` | The effective timezone from Settings (IANA name; `UTC` when blank)                                                                   |
| `{{botlid}}`   | The bot account's own id (lid digits); the default prompt uses it so the model recognizes its earlier replies and mentions of itself |

In the trigger's **error message** these placeholders work:

| Placeholder    | Replaced with                                                                        |
| -------------- | ------------------------------------------------------------------------------------ |
| `{{error}}`    | A short reason, for example "the daily AI usage limit (200 calls) is reached"        |
| `{{trigger}}`  | The trigger's name                                                                   |
| `{{group}}`    | The name of the group where the message was posted                                   |
| `{{user}}`     | The author of the message, written as a mention (`@<digits>`)                        |
| `{{message}}`  | The text of the message, cut to about 200 characters                                 |

Unknown `{{tokens}}` are left as-is.

### Privacy note

When the bot answers, message content from the tenant's groups is sent to Google's
Gemini API. On the **free tier Google uses submitted content to improve its products
(including human review); the paid tier does not.** If the groups are private,
use a paid-tier API key. See Google's current Gemini API terms for details.

### Spam trigger

The **Spam** trigger looks at new messages in the tenant's groups, asks the AI whether a
message is spam, and reports what it finds to a group of your choice. It can also
delete spam and remove spammers, but only when those actions are ticked. All actions are
off by default, so out of the box it only reports.

Add it with **+ Add trigger** and choose **Spam**. The settings:

- **Watched groups**: all groups of the tenant, only the selected groups, or all groups
  except the selected ones. You can also limit it by the bot's role in the group (any, admin,
  or not an admin), checked when the message arrives.
- **Conditions**: a message is only checked if all the ticked conditions are true.
  - **The message content matches**: it has a link, it has an image, or its text matches a
    pattern (a regular expression). Any one of these is enough. Defaults: link and image.
  - **The sender is not an admin** (on by default).
  - **The sender joined less than N days ago** (off by default).
  - **The sender has fewer than N messages in this group** (off by default).
- **Timing**: the bot waits 10 seconds before checking (so a quick delete or a copy of the
  same text in other groups can be seen first), and ignores messages older than 60 minutes.
  Both can be changed.
- **Post reports and errors to**: the notification group. It must be one of the tenant's
  groups. Reports and error messages are posted there. Messages in this group are not
  checked.
- **Actions**: all off by default.
  - When the AI says it is spam from a spammer: "Delete all copies of the message in this
    tenant's groups" and "Remove the user (from the community, or else from the groups)".
  - When the AI says it is spam, but not from a spammer: "Delete the message". This deletes
    only that one message. Each copy is deleted by its own check, and the report is updated.
- **Prompt**, **Additional instructions** and **Error message** work as for Mentions. The
  default error message is `⚠️ Spam check failed for a message by {{user}} in {{group}}: {{error}}`.

The AI only reads. It can look at the sender (when they joined, what else they posted, the
same text in other groups) with the same read-only data tools as Mentions, and it answers
two questions: is the message **spam**, and is the sender a **spammer**. A long-time member
who posts one ad is spam but not a spammer. If the AI says the message is not spam, nothing
is posted.

**Deleting and removing** rules:

- The bot can only delete messages or remove users in groups where it is an admin.
- If the message or one of its copies was posted in a community where the bot is a
  community admin, the user is removed from that community (all its groups at once). Every
  other group with a copy is handled one by one. If removing from the community fails, the bot does not try
  its groups one by one, and the report says so.
- An admin of the group is never removed (for community removal: an admin of the community
  or of any of its groups). The bot never removes itself.
- A copy that is already deleted, or a user who is already removed, is simply skipped.

**Reports** use `@` mentions, so users and groups are tappable. If the sender is a spammer:

```
Detected spam by user @<user>:

*Not deleted!*
- group @<group>

*Deleted messages:*
- group @<group>

User removed from the community
User removed from: @<group>, @<group>
Could not remove the user from: @<group>

*Message contents:*
<text>
```

If the message is spam but the sender is not judged a spammer:

```
Suspicious message by user @<user>

*Not deleted:*
- group @<group>

*Deleted:*
- group @<group>

<text>
```

Sections appear only when they have something to show. The removal lines appear only when
"Remove the user" is ticked. Instead of "User removed from the community" the report can say
"User is not removed from the community".

The same text from the same user is often posted in several groups. If the trigger already
reported that user and text less than about 15 minutes ago (the time WhatsApp allows for
editing a message), the earlier report is **edited** to add the new group instead of posting
a new one, and the AI's earlier verdict is reused, so a wave of copies costs one AI call.
A "copy" is another message by the same user with the same text (ignoring extra spaces)
that is not deleted. Copies count only if they were posted in the last 24 hours; older ones
are not listed in the report and are not shown to the AI.
Messages without text are never merged. If editing would lose the tappable group mentions,
a new report is posted instead.

Errors (for example the AI is busy or the daily limit is reached) are posted to the
notification group at most once every 10 minutes per trigger; the rest only go to the job
log. Every check is a `spam_check` job on the **Bot jobs** page, with the AI's verdict in
its log. The job log also shows what was deleted or removed, and why something was not. As with Mentions, the text of checked messages is sent to the Gemini API (see the
privacy note above).

## Environment Variables

| Variable         | Default      | Description                           |
| ---------------- | ------------ | ------------------------------------- |
| `ADMIN_PASSWORD` | _(required)_ | Password for the web panel            |
| `ADMIN_USERNAME` | `admin`      | Username for the web panel            |
| `PORT`           | `3000`       | Web server port                       |
| `DATA_DIR`       | `./data`     | Directory for auth state and database |
| `LOG_LEVEL`      | `info`       | `debug`, `info`, `warn`, `error`      |

Additional settings (project name, page size, chat history import) are configurable from the Settings page.

## How It Works

When you use web.whatsapp.com, you link your WhatsApp account to the browser by scanning a QR code. Through WhatsApp Web you can send and receive messages and do pretty much everything you can do in the mobile app. Baileys is a library that **reverse-engineered the WhatsApp Web protocol**, allowing us to connect to WhatsApp as if we were a browser. This means we can track all the same events and data that WhatsApp Web has access to, including group activity.

Similarly, you need to **connect** the monitor to your WhatsApp account by scanning a QR code. WhatsApp allows up to 4 linked devices at a time. Once connected, the session credentials are saved to your data directory. After that, you can stop the container and restart it without needing to scan the QR code again.

If you restart the container while it was connected, the WhatsApp protocol will re-send all events that occurred while the monitor was offline. You can even restart after several days and catch up on everything you missed.

## Backup, Restore, and Migration

You can back up your data at any time.

Here is the recommended workflow for **migrating** your monitor to a new server or instance (local ↔ Docker ↔ Railway):

- Keep the old instance running and connected to WhatsApp.
- Start the new instance and connect it to WhatsApp by scanning the QR code. Both instances are now connected and tracking the same data in parallel (WhatsApp allows up to 4 linked devices).
- Use the backup feature on the old instance to download a backup file.
- Use the restore feature on the new instance to upload the backup file and apply it using the **merge** option.
- Disconnect the old instance from WhatsApp (unlink the device) and stop it.

Any events that occurred after the backup was taken but before the restore will already be present in the new instance, so no data will be lost.

## Data Isolation

Each WhatsApp account gets its own database at `data/{phone}/account.db`. Disconnecting and connecting a different number creates a separate database — no data mixing between accounts. Shared settings are stored in `data/monitor.db`.

Only one WhatsApp account can be connected at a time. Activity is only tracked while the account is connected. If you need to monitor multiple accounts simultaneously, set up a separate instance (container) for each one.

## Tech Stack

Baileys (WhatsApp Web) + Fastify + SQLite (better-sqlite3) + Drizzle ORM + TypeScript + @google/genai (Gemini)

## License

[MIT](LICENSE)
