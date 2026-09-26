# WhatsApp Group Monitor

Self-hosted WhatsApp group activity monitor. Tracks group members, messages, reactions, polls, and events via a web dashboard.

## WhatsApp Account

This tool uses [Baileys](https://github.com/WhiskeySockets/Baileys), an open-source library that connects to WhatsApp as a linked device. No WhatsApp Business account or API subscription is needed — a regular WhatsApp account works.

You can use your own WhatsApp account or a dedicated one. The monitor connects as a linked device and passively tracks group activity without interfering with normal use.

If the service restarts, it automatically catches up on messages it missed while offline. However, if you disconnect (unlink the device) and re-connect, messages sent while disconnected will not be recovered.

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

## Getting Started

1. Open the web panel and log in
2. Scan the QR code with WhatsApp (Linked Devices > Link a Device)
3. The dashboard shows all groups the account is in, with member counts and activity stats

## AI Q&A Assistant

You can designate **Q&A groups**: WhatsApp groups whose members can ask the bot
questions about activity in other monitored groups — message counts, conversation
summaries, most/least active members, poll attendance.

Setup:

1. Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/) and enter
   it on the **Settings** page. The model, a daily call limit, the timezone used for all
   dates, and the main system prompt (placeholders: `{{timezone}}`, `{{botlid}}`) are
   configurable there too.
2. Open the group's page in the panel, enable **Q&A assistant** in the Bot card, and
   link the groups and/or communities it may report on. Linking a community covers all
   its groups, including ones added later. The Q&A group itself is always included, and
   per-group instructions can adjust the bot's tone or language.
3. Members of the Q&A group talk to the bot by **@mentioning** the connected account
   or **replying** to one of its messages. Replying to an answer continues that
   conversation — the bot re-reads the earlier exchange. It also sees the group's
   recent messages (up to 20, at most 48 hours old) as context.

Every question becomes a **job** — see the **Bot jobs** page (linked from the status
bar) for status, the full AI interaction trail and token usage of each one. Answers
are based only on activity this monitor has recorded; the bot cannot see history from
before it was connected (except what WhatsApp's history sync provided).

For debugging, two commands answer without calling the AI: `@bot !tools` lists the
data tools, and `@bot !tool <name> <json-args>` runs one and echoes its raw result.

### Privacy note

When the bot answers, message content from the linked groups is sent to Google's
Gemini API. On the **free tier Google uses submitted content to improve its products
(including human review); the paid tier does not.** If the linked groups are private,
use a paid-tier API key. See Google's current Gemini API terms for details.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_PASSWORD` | *(required)* | Password for the web panel |
| `ADMIN_USERNAME` | `admin` | Username for the web panel |
| `PORT` | `3000` | Web server port |
| `DATA_DIR` | `./data` | Directory for auth state and database |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Additional settings (project name, page size) are configurable from the Settings page.

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
