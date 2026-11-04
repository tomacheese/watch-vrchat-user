# watch-vrchat-user

An application that watches state changes of all your VRChat friends and sends a Discord notification for every change that matches a CEL rule written in a YAML configuration file.

## Features

- Tracks and persists the state of all friends in real time (online / offline / Location / status / status message)
- Treats the first Location confirmed after a friend comes online as a `location-change` event
- CEL rules decide both whether to notify and which Discord webhook to notify (when one event matches several rules, every matched destination is notified)
- When several rules match the same destination, they are merged into one message and the Embed footer lists all matched rule names
- The user name, world name, instance label (such as `Friends+ #2`) and instance owner in an Embed link to VRChat Web. The instance label links to the launch URL of that instance, which contains a random identifier (nonce) for Friends+ and similar instance types. Send notifications only to channels that nobody else can see
- Hot reload of the configuration file (reloading an invalid configuration fails and the last known good configuration keeps running)
- World information lookup (cached for 24 hours) and Favorite Friends (`group_0` to `group_3`) lookup (refreshed hourly)
- Session persistence and recovery from expired authentication (2FA is entered automatically when a TOTP secret is configured)
- Persistent notification outbox and delivery results: pending notifications continue after a restart, and notifications whose delivery is uncertain wait for explicit recovery

## Requirements

- Node.js (the version is pinned in `.node-version`; the built-in `node:sqlite` module is used)
- pnpm (the version is pinned by `packageManager` in `package.json`)
- A VRChat account
- A Discord webhook URL

## Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Set environment variables

Create a `.env` file and set the following environment variables. When running locally, `.env` is loaded at startup; environment variables that are already set take precedence.

```env
# Notification configuration file for local runs
CONFIG_PATH=data/config.yaml

# VRChat credentials
VRCHAT_USERNAME=your_vrchat_username
VRCHAT_PASSWORD=your_vrchat_password
VRCHAT_TOTP_SECRET=your_totp_secret  # Optional: TOTP secret (2FA codes are entered automatically when set)

# Discord webhook URLs referenced from ${ENV_VAR} in the configuration file (the config.example.yaml example)
DISCORD_WEBHOOK_MAIN=https://discord.com/api/webhooks/xxx/yyy
DISCORD_WEBHOOK_DANCE=https://discord.com/api/webhooks/xxx/zzz

# Error reporting
SENTRY_DSN=https://xxx@yyy.example.com/1  # Optional: GlitchTip/Sentry DSN (error reporting is disabled when unset)
```

Other environment variables (all optional):

| Environment variable    | Default (Docker)                                       | Description                                                                                            |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `CONFIG_PATH`           | `/data/config.yaml`                                    | Path of the notification rule configuration file (YAML)                                                |
| `COOKIE_FILE_PATH`      | `data/vrchat-cookies.json` (`/data/vrchat-cookies.json`) | Where the VRChat session cookies are stored                                                          |
| `STATE_FILE_PATH`       | `data/friend-states.json` (`/data/friend-states.json`) | Migration source for an existing JSON state; the live database is the `.sqlite` file at the same place |
| `WORLD_CACHE_FILE_PATH` | `data/world-cache.json` (`/data/world-cache.json`)     | Where the world information cache is stored                                                            |
| `OWNER_CACHE_FILE_PATH` | `data/owner-cache.json` (`/data/owner-cache.json`)     | Where the instance owner name cache is stored                                                          |
| `HEALTH_HOST`           | `127.0.0.1`                                            | Bind address of the health check server                                                                |
| `HEALTH_PORT`           | `3000`                                                 | Port of the health check server                                                                        |

> **Note**: If `VRCHAT_TOTP_SECRET` is not set, you must enter the 2FA code manually on the first start.

### 3. Create the configuration file

Copy `config.example.yaml` to `data/config.yaml` and edit the rules. Startup fails if the configuration file is missing or invalid.

```bash
mkdir -p data
cp config.example.yaml data/config.yaml
```

## Configuration file

```yaml
version: 1
destinations:
  main:
    type: discord-webhook
    url: ${DISCORD_WEBHOOK_MAIN}
rules:
  - name: dance-world
    enabled: true
    when: |
      event.type == "location-change" &&
      current.location != null &&
      current.location.visible &&
      current.location.world.name.contains("ダンス")
    destinations: [main]
```

- `version` is fixed to `1`.
- Each key under `destinations` is a destination name, and `type` can only be `discord-webhook`. `url` is either written directly or, when the whole value is `${ENV_VAR}`, expanded from the environment (expansion applies only when the entire value of `destinations.*.url` is `${NAME}`; an undefined variable is a configuration error). The expanded URL must start with `https://discord.com/api/webhooks/`.
- `rules[].name` is required and must be unique within the configuration. `enabled` defaults to `true`. `destinations` needs at least one entry and may only name destinations that are defined. `when` is a CEL expression that returns a boolean (at most 4096 characters).
- Unknown keys are errors (typo detection). Rules with `enabled: false` are still syntax-checked but never evaluated.
- Webhook URLs are secrets. Do not write them directly in the configuration file; pass them through `${ENV_VAR}` instead. They are never written to logs or health output. Pending notifications need the URL that was valid when they were accepted, so the expanded URL is stored in `friend-states.sqlite`. Treat backups as secrets too.

### Semantic events

`event.type` is one of the following six values.

| `event.type`      | Meaning                                                                                                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `online`          | The friend went from offline to online                                                                                                                                                                                                                   |
| `offline`         | The friend went from online to offline                                                                                                                                                                                                                   |
| `location-change` | The Location of an online friend changed to a different public Location, or changed from a public Location to private (including a return from private and a Location confirmed at the same time as the friend comes online)                             |
| `friend-add`      | A friend was added                                                                                                                                                                                                                                       |
| `friend-delete`   | A friend was removed                                                                                                                                                                                                                                     |
| `status-change`   | The friend's status (Join Me / Online / Ask Me / Do Not Disturb) or status message changed                                                                                                                                                               |

- `location-change` fires when the new Location is **public** (the world can be identified). The previous Location may be either public or private. It also fires on a transition from a public Location to private; in that case `current.location` is `{ visible: false }` (note that this also matches rules that do not check `current.location.visible`). When a public Location is confirmed at the same time as the friend goes from offline to online, `location-change` follows `online` (a rule that matches both notifies twice). It does not fire when the Location stays private, when a Location is confirmed after being unknown (except the first confirmation right after the friend comes online), or when it goes from unknown to private.
- `status-change` fires when the status or the status message changes in a profile that arrives with a WebSocket `friend-update` or a presence / Location event (compare `status` / `statusDescription` in `previous` and `current` to see which one changed). The Friends API REST snapshot is used only to initialize profile fields that have not been observed yet; it never overwrites confirmed values and never produces `status-change`. Status values are `join me` / `active` / `ask me` / `busy` (`active` is Online, `busy` is Do Not Disturb). When it is detected together with another event such as `online`, it follows that event. Status and message are tracked per field and only a change from a confirmed value is notified. The first observation of each field (including right after upgrading) is recorded without a notification, so notifications start from the next change. The `offline` status is not recorded and the previous value is kept, so an offline user may have an unconfirmed status, but message changes are still notified in that case (the Embed shows only the field that changed).
- For after-the-fact investigation, every state change is logged (info) as `State changed: user=... <before> -> <after> effects=...`, and every rule evaluation as `Matched rules:` or `No rule matched:`. Transitions that produced no notification can be traced through these logs.
- To investigate WebSocket reconnects, each reconnect writes a `reconnect-triggered` diagnostic log containing the raw close `closeCode` / `closeReason` (alphanumerics and a few symbols only, up to 64 characters) and the milliseconds since the last message and pong (`msSinceLastMessage` / `msSinceLastPong`). Every REST synchronization logs `Reconciliation snapshot applied: friends=N drift=M`, where `drift` is a rough measure of the differences that did not arrive over the WebSocket.
- When the WebSocket stays silent for 10 minutes (only while the connection is `ready`), the application does not reconnect immediately but first compares against the Friends API. With 0 differences it keeps the connection (`Pipeline liveness probe: drift=0 action=keep ...`); with differences, when synchronization is impossible, or when the check does not finish within 120 seconds, it reconnects (`Pipeline liveness probe: drift=<N> action=reconnect ...` / `unverified action=reconnect ...`). The check runs at most once every 10 minutes while the silence continues, and its result is only logged, not included in the `/health` diagnostic history.
- The WebSocket `traveling` state is not used to confirm a Location or to change presence. A status change in the attached profile is still tracked as usual. REST synchronization treats a traveling friend as online and keeps the confirmed Location.
- On the first start (no state file), a baseline of the current state of all friends is recorded **without notifications**. Changing Favorite groups or reloading the configuration never re-evaluates past events or sends retroactive notifications.
- WebSocket `status-change` detection uses the profile attached to `friend-update` and presence / Location events. Friends API synchronization only initializes unconfirmed profile fields and otherwise reconciles online / offline / Location state.

### CEL variables

| Variable                       | Content                                                                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event.type`                   | One of the six values above                                                                                                                                                   |
| `event.month` / `event.day`    | Month (1-12) and day (1-31) of the time the event was received                                                                                                                |
| `event.weekday`                | Day of the week of the time the event was received (0 = Sunday to 6 = Saturday)                                                                                               |
| `event.hour` / `event.minute`  | Hour (0-23) and minute (0-59) of the time the event was received. A night-time condition looks like `event.hour >= 22 \|\| event.hour < 6`                                    |
| (about time variables)         | Even if delivery is delayed, the stored `createdAt` is used instead of the delivery time. Time variables are interpreted in the application's local time zone (JST in the production container) |
| `user.id` / `user.displayName` | User ID and display name of the friend concerned                                                                                                                              |
| `previous` / `current`         | State before and after the event. `previous == null` for `friend-add` and `current == null` for `friend-delete`                                                                |

`previous` / `current` have the following fields:

- `presence`: `"online"` or `"offline"`
- `status` / `statusDescription`: status (`join me` / `active` / `ask me` / `busy`) and status message. Empty strings when not observed yet
- `favoriteGroups`: the Favorite groups the friend belongs to (`group_0` to `group_3`)
- `location`: `null` when offline. It is also `null` for an online friend whose Location is not confirmed, so use `presence` to check whether a friend is present. Non-public Locations such as private are `{ visible: false }`. A public Location has the following structure:
  - `location.visible`: `true`
  - `location.world.id`: world ID
  - `location.world.name`: world name (present only when world information is available; when it cannot be fetched, a rule that references it fails to evaluate and only that rule is treated as not matching)
  - `location.world.capacity`: maximum capacity of the world (present only when world information is available; same failure behavior as `world.name`)
  - `location.instance.name` / `type` / `ownerId` / `region` / `ageGate`

`location.instance.type` is one of the following eight values:

| `type`          | Meaning              |
| --------------- | -------------------- |
| `public`        | Public               |
| `friends-plus`  | Friends+             |
| `friends`       | Friends              |
| `invite-plus`   | Invite+              |
| `invite`        | Invite               |
| `group-public`  | Group Public         |
| `group-plus`    | Group+               |
| `group-members` | Group (members only) |

### Rule examples

`config.example.yaml` contains the following examples (plus a status message example). Replace the `usr_...` values with real user IDs.

```yaml
rules:
  # Notify only about Location changes of a specific user
  - name: specific-user-location
    when: |
      event.type == "location-change" &&
      user.id == "usr_00000000-0000-0000-0000-000000000000"
    destinations: [main]

  # Notify only about online / offline of a specific user
  - name: specific-user-presence
    when: |
      (event.type == "online" || event.type == "offline") &&
      user.id == "usr_00000000-0000-0000-0000-000000000000"
    destinations: [main]

  # Notify when someone moves to a world whose name contains "ダンス" (dance)
  - name: dance-world
    when: |
      event.type == "location-change" &&
      current.location != null &&
      current.location.visible &&
      current.location.world.name.contains("ダンス")
    destinations: [dance]

  # Notify about online / offline of friends in Favorite group group_0
  - name: favorite-group-0-presence
    when: |
      (event.type == "online" || event.type == "offline") &&
      (("group_0" in current.favoriteGroups) ||
       ("group_0" in previous.favoriteGroups))
    destinations: [main]
```

### Hot reload

When the configuration file is saved, it is reloaded automatically after a short delay of a few seconds. The reloaded configuration applies to events detected afterwards. Pending notifications keep the configuration from when they were accepted, so they are still processed with the rules and destinations of that time. If you change or disable a webhook, also check the pending notifications of the old destination. Reloading an invalid configuration (YAML syntax error, unknown key, invalid CEL expression, and so on) fails and the last known good configuration keeps running. The failure is reflected in the `config` field of the health output. If the configuration is invalid at startup, startup fails.

Each rule is evaluated with a time limit. A rule that exceeds the limit or fails to evaluate is recorded and treated as not matching, and evaluation of the other rules continues.

## Usage

### Development mode

```bash
pnpm dev
```

### Production mode

```bash
pnpm start
```

### Using Docker

`./data` is mounted at `/data`, so prepare `./data/config.yaml`. Environment variables referenced as `${ENV_VAR}` from the configuration file must be added to `environment` in `compose.yaml` so that they reach the container (the bundled `compose.yaml` passes `DISCORD_WEBHOOK_MAIN` and `DISCORD_WEBHOOK_DANCE` as an example).

```bash
docker compose up -d
```

Follow the logs:

```bash
docker compose logs -f
```

### Health check

`/health` on `HEALTH_HOST` (default `127.0.0.1`) and `HEALTH_PORT` (default `3000`) returns JSON. It includes `baselineCompleted` (whether the initial synchronization is done), `config` (configuration loading state), `ruleErrors` (rule evaluation errors), `favorites` (Favorite Friends refresh state), the REST synchronization result, and `delivery` (counts of pending, uncertain and blocked notifications).

- `healthy`: normal
- `degraded` (HTTP 200): there is a problem with configuration reload, rule evaluation, Favorite Friends, REST synchronization or notification delivery, or a pending notification has been stuck for 60 seconds or more. Blocked and uncertain notifications need recovery
- `unhealthy` (HTTP 503): the WebSocket connection is not ready, the initial baseline is not completed, or there is a per-user problem

Pipeline connection diagnostics are written to the log, and `/health` shows the latest 25 entries (reason, reconnect attempt and result). Diagnostic events contain no user information, Location, cookies, webhook URLs or raw event payloads.

## Data persistence

The following files are stored in the `data/` directory.

- `vrchat-cookies.json` - VRChat session cookies
- `friend-states.sqlite` - state of all friends, pending notifications, configuration snapshots and per-destination delivery results
- `friend-states.json` - JSON store of older versions. It is validated and migrated to SQLite exactly once on first start, and the original file is kept
- `world-cache.json` - world information cache (24-hour TTL)
- `owner-cache.json` - instance owner (user name / group name) cache (24-hour TTL)
- `config.yaml` - notification rule configuration file (provided by you)

State and pending notifications are committed in the same SQLite transaction. The delivery state of a destination updates only its own row, and the same configuration snapshot is not copied for every outbox item. The configuration file is limited to 1 MiB, 64 destinations and 256 rules. The outbox keeps at most 10,000 items and 32 configuration snapshots that are still in use. On shutdown, the application stops accepting new events and waits up to 5 seconds each for state updates and for notification delivery. If the whole shutdown takes longer than 15 seconds, the process exits abnormally and recovers from the stored data on the next start. Stored pending notifications are carried over to the next start. The SQLite database and its lock database are stored with owner-only read/write permissions (`0600`). They contain Location nonces, status messages and webhook URLs, so do not share or publish `data/` or its backups.

### Notification recovery

Notifications are processed in per-user order. Discord rate limits (429) and server errors (5xx) are retried after waiting. Permanent client errors (4xx) are stored as `blocked`, and cases where delivery cannot be confirmed, such as timeouts and lost connections, are stored as `uncertain`. Because the application records that a notification is being sent before the POST, a notification that was still being sent at shutdown also becomes `uncertain` after the restart. To avoid duplicate delivery, uncertain notifications are never retried automatically. When the first notification of a user is `blocked` or `uncertain`, that user's later notifications wait until it is recovered.

Run the recovery commands only while the application is stopped. Running the application and a recovery command against the same state store at the same time is rejected by the SQLite exclusive lock. Make sure `STATE_FILE_PATH` in `.env` points to the same migration source path as the running application.

```bash
pnpm outbox list
pnpm outbox retry <id> <destination>
pnpm outbox discard <id> <destination>

# Retry a notification preparation failure / discard the whole event
pnpm outbox retry <id>
pnpm outbox discard <id>
```

Use `list` to see the notification IDs and the state of each destination. Also check the Discord channel, and put back for retry with `retry` only notifications that you are sure were not delivered; retrying an `uncertain` notification may produce a duplicate. Use `discard` to finish processing of that destination for a notification that already arrived or is not needed. The state of other destinations that are still pending is kept. A preparation failure that happened before destinations were created is re-evaluated by `retry <id>` without a destination. `discard <id>` without a destination discards the whole event and does not deliver it to its remaining destinations either.

With Docker, stop the application with `docker compose stop app` and run the command with the same volume. Resume with `docker compose start app` when recovery is done.

```bash
docker compose run --rm --entrypoint pnpm app outbox list
```

### State file compatibility and recovery from corruption

Schema 3 of `friend-states.json` is migrated to SQLite exactly once. A schema 3 file written by an older version without `outbox` can still be loaded. SQLite uses internal schema version 1. If an existing file has an unsupported format (invalid JSON, an invalid record, schema 2, a corrupted SQLite database, and so on), startup stops instead of overwriting it with empty data. The original JSON is not updated even after the SQLite database has been created.

Stop the application and preserve the SQLite database (`friend-states.sqlite`) and the migration source JSON. Do not recreate the state unless you have a healthy backup: recreating it makes the existing state, pending notifications and delivery results unrecoverable. When you restore changes made after the backup was taken, also check the delivery status on the Discord side.

## Migration from an older version

The old environment-variable based settings were removed and there is no backward compatibility.

1. Move the old `DISCORD_WEBHOOK_URL` (removed) to a new environment variable (for example `DISCORD_WEBHOOK_MAIN`) and reference it from `url: ${DISCORD_WEBHOOK_MAIN}` in `destinations`.
2. For each user in the old `TARGET_USER_IDS` (removed), add a rule whose condition is `user.id == "usr_..."` (see the first and second rules in "Rule examples" above).
3. The old `LOCATION_FILE_PATH` (removed) is no longer needed. The old `user-locations.json` is not carried over. The new version migrates `friend-states.json` to SQLite (`friend-states.sqlite`) if it exists, and creates a SQLite store otherwise.
4. The first start builds a baseline by recording the current state of all friends without notifications. During this time and right after it, no notification is sent based on the existing state.

### Rollback

Stop the application before switching and back up the whole `data/` directory. If you go back to an old JSON-only image after migrating to SQLite, the old version does not read the changes made in SQLite after the migration. To roll back, restore the backup taken before the switch and bring back the old environment variables (`DISCORD_WEBHOOK_URL` / `TARGET_USER_IDS`). The old `user-locations.json` is not modified by the new version. The delivery results of pending notifications are stored in the new SQLite database, so check the delivery status on the Discord side before rolling back.

## Development

See [AGENTS.md](AGENTS.md) for the architecture and conventions.

```bash
pnpm lint   # prettier check + eslint + tsc
pnpm fix    # prettier write + eslint --fix
pnpm test   # jest with coverage
```

## License

The project is licensed under the [MIT License](LICENSE).
