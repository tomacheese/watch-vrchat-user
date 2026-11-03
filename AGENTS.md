# AGENTS.md

Guidance for AI coding agents working in this repository. `CLAUDE.md` only imports this file; `.github/copilot-instructions.md` holds the Copilot review points.

## Language

- Write everything in English: commit messages, PR / Issue titles and bodies, review comments, code comments / JSDoc, and documentation (including `README.md` and this file).
- Exceptions: end-user-facing notification text (the Japanese Discord Embed labels in `src/notifications/embed-builder.ts`), the Japanese fork-PR approval comment and its `body-includes` key in `.github/workflows/docker.yml` (they must match each other), Japanese fixture / example values (such as the `ダンス` rule examples), quotations, technical identifiers, generated files, and external source text.
- Runtime log and error messages are English.

## Overview

A Node.js / TypeScript application that watches state changes of all VRChat friends (online / offline / Location / status / status message / friend add and delete) over the VRChat WebSocket pipeline, with the Friends API used for REST reconciliation. Changes that match CEL rules in a YAML configuration file are sent to Discord webhooks. The configuration file is hot reloaded. See `README.md` for user-facing behavior (event semantics, CEL variables, recovery procedures).

## Development commands

- Node.js version: `.node-version`; package manager: `pnpm` only (enforced by the `preinstall` `only-allow` hook; the version is pinned by `packageManager` in `package.json`).

```bash
pnpm install                      # install dependencies
pnpm dev                          # run with reload (tsx watch)
pnpm start                        # run (tsx ./src/main.ts)
pnpm lint                         # prettier check + eslint + tsc
pnpm fix                          # prettier write + eslint --fix
pnpm test                         # jest (ts-jest, **/*.test.ts) with coverage

# Notification recovery (only while the app is stopped)
pnpm outbox list
pnpm outbox retry <id> <destination>
pnpm outbox discard <id> <destination>
pnpm outbox retry <id>            # re-evaluate a preparation failure
pnpm outbox discard <id>          # discard the whole event
```

## Architecture

- `src/env.ts`: loads `.env`; must be imported before any module that initializes paths, cookies or the logger.
- `src/main.ts`: entry point; loads environment and configuration, starts `App`, handles signals.
- `src/outbox-cli.ts`: lists / retries / discards stopped-app outbox items; takes the same SQLite OS lock as the app.
- `src/app.ts`: wires the modules together and runs the startup / reconnect / periodic REST reconciliation sequence.
- `src/config.ts`: reads and validates VRChat credentials and path settings from environment variables (`CONFIG_PATH`, `STATE_FILE_PATH`, `WORLD_CACHE_FILE_PATH`, ...).
- `src/config/`: `config-file.ts` parses and validates the YAML configuration (including `${ENV_VAR}` expansion of destination URLs), `config-manager.ts` hot reloads it and keeps the last known good snapshot, `config-snapshot.ts` is the validated and compiled snapshot.
- `src/rules/`: `rule-engine.ts` compiles CEL rules and keeps `RuleErrorLog`; `rule-evaluator.ts` evaluates CEL in an isolated Worker with execution time, startup time, cache and Worker heap limits, and treats only a failing rule as not matching; `rule-context.ts` builds the CEL variables (`event` / `user` / `previous` / `current`) from an effect. `event.type` is one of `online` / `offline` / `location-change` / `friend-add` / `friend-delete` / `status-change`; the time variables (`month` / `day` / `weekday` / `hour` / `minute`) come from the persisted `createdAt` in the local time zone.
- `src/vrchat/`: `session.ts` (REST authentication, cookie persistence, 2FA, explicit re-authentication, Friends API; it does not start the pipeline), `pipeline-transport.ts` (the only access path to the SDK's raw WebSocket), `pipeline-supervisor.ts` (connection state, generation, liveness, reconnect backoff, stale probe through REST reconciliation), `pipeline-event-router.ts` (normalizes `friend-*` events and hands them to `UserStateCoordinator`), `world-resolver.ts` (world / owner lookups with a persistent 24-hour TTL cache, capped at 10,000 entries), `favorites-service.ts` (Favorite Friends `group_0` to `group_3`, refreshed hourly).
- `src/state/`: `location.ts` (raw Location parsing), `user-state.ts` (persisted `FriendState` types and validation), `user-state-reducer.ts` (pure transitions shared by WebSocket events and REST snapshots), `user-state-repository.ts` (JSON to SQLite migration, state + outbox transactions, OS-level lock, `0600`), `user-state-coordinator.ts` (single-writer queue per user; persists effect, followUp and statusEffect with the outbox atomically; never waits for the network), `reconciler.ts` (compare-and-enqueue of Friends API snapshots).
- `src/notifications/`: `outbox-types.ts` (persisted raw CEL, expanded destinations, events, payloads and delivery state), `notification-outbox.ts` (evaluates stored effects with the configuration and time of reception, stores payloads before sending, keeps per-user order), `notification-dispatcher.ts` (evaluates all rules and merges matched rules per destination into one payload), `embed-builder.ts` (Discord Embed), `discord-notifier.ts` (native fetch, per-webhook queue, 429 handling, 5xx / permanent 4xx / uncertain classification).
- `src/health/health-service.ts`: localhost-only `/health` HTTP server reporting `healthy` / `degraded` / `unhealthy`.
- `src/logger-utils.ts`: `toError` helper.
- `config.example.yaml`: example configuration (copied to `data/config.yaml`); parsed and compiled in tests.
- `data/`: persisted data (cookies, `friend-states.sqlite`, legacy `friend-states.json`, `world-cache.json`, `owner-cache.json`, `config.yaml`). Git-ignored.
- `patches/vrchat@<version>.patch`: patch applied to the `vrchat` package (see `patchedDependencies` in `pnpm-workspace.yaml`). When updating `vrchat`, rename or regenerate the patch and verify it still applies.

## Conventions

- Conventional Commits (`<type>(<scope>): <description>`), Conventional Branch names (`feat/xxx`, `fix/xxx`). Do not commit to Renovate-created PRs; apply the change on a normal branch instead.
- Comments and JSDoc in English. Document functions and interfaces with JSDoc, and keep it accurate when behavior changes. Error and log messages are English; if emoji are used in a message, use them consistently within the message.
- TypeScript is `strict`; do not use `skipLibCheck`, and do not add `any`.
- Add tests for new logic following the existing patterns (Jest + `ts-jest`).
- Update `README.md`, this file and `.github/copilot-instructions.md` when features, architecture or commands change.

## Security and secrets

- Never commit `.env` or `data/` (credentials, cookies, history).
- Never log VRCHAT credentials, TOTP secrets, cookies, Location nonces or Discord webhook URLs (including expanded `destinations` values). Do not log raw events, even for invalid payloads.
- The outbox deliberately stores expanded webhook URLs, raw CEL, Location nonces, status messages and Embeds so pending notifications survive a restart. Treat `friend-states.sqlite` and its backups as secrets; health output and the recovery CLI listing must not expose bodies or URLs.

## VRChat API / WebSocket notes

- Use the VRChat Web API only through the `vrchat` SDK (it adds query parameters such as `apiKey` itself). Authentication is username / password + TOTP 2FA; cookies are persisted under `data/` with `keyv-file` to reduce re-logins.
- Real-time events come from the pipeline WebSocket (`wss://pipeline.vrchat.cloud/`): `friend-location` (core of Location tracking), `friend-online`, `friend-offline`, `friend-update` (status / status message), `friend-add`, `friend-delete`, `notification`. `friend-add` / `friend-delete` are not in the SDK types, so their payload shape is based on unofficial documentation and is validated by type guards in the router. The `friend-update` payload shape was confirmed against a real account (2026-09-30): `userId`, `user.displayName`, `user.status` and `user.statusDescription` arrive as strings; status-only and message-only changes arrive as a standalone `friend-update`. Non-string `status` / `statusDescription` are ignored.
- The API may change; check the official (https://creators.vrchat.com/) and community (https://vrchatapi.github.io/) documentation.
- Location change detection compares `friend-location` against the previous value in `user-state-reducer.ts` and suppresses duplicates. `location-change` is generated when current is visible (`wrld_...`) and previous is non-null (visible or `private`), and when current is `private` and previous is visible (then CEL `current.location` is `{ visible: false }`). offline to online with a visible Location yields `online` followed by `location-change` (a `followUp`, persisted in order effect then followUp). Staying private, `traveling`, null to visible (except the first Location right after online) and null to private notify nothing.
- `status-change` comes from profile observations (`friend-update` / `friend-online` / `friend-location`). Friends API snapshot profiles only initialize unconfirmed fields: they never overwrite confirmed values and never generate `status-change`. The `offline` status is not recorded (the previous value is kept). Status and message are judged per field: only a change from a recorded value notifies; the first observation of a field is recorded silently; an empty string counts as recorded.
- Diagnostics: the coordinator logs `State changed:` for every state change, the dispatcher logs `Matched rules:` / `No rule matched:`, the supervisor's `reconnect-triggered` log carries `closeCode` / `closeReason` (alphanumerics and a few symbols, up to 64 chars) and `msSinceLastMessage` / `msSinceLastPong`, and the reconciler logs `Reconciliation snapshot applied: friends=N drift=M` (status differences are not counted in `drift`).
- After 10 minutes without a raw message, in `ready` state only, the supervisor first runs `Reconciler.reconcileAll()` as a liveness probe. `drift=0` keeps the connection (`Pipeline liveness probe: drift=0 action=keep ...`); `drift>=1`, an unavailable result (null / exception) or the 120-second probe timeout reconnects. At most one probe per 10 minutes of continuing silence; in any state other than `ready` it reconnects immediately. Probe results are only logged, not part of reconnect diagnostics or health.

## Embed rules (`embed-builder.ts`)

- The public Location is one line: `<world> · <instance #n>`, followed by ` · 👤 <owner>` (` · 👥 <group>` for groups); no owner suffix for public instances. Unresolved names fall back to the raw ID. Owner names are display-only and never exposed to CEL.
- Links: user `https://vrchat.com/home/user/<usr_id>`, world `.../home/world/<wrld_id>`, instance `.../home/launch?worldId=...&instanceId=...`, group `.../home/group/<grp_id>`. URL-encode `instanceId` including parentheses, and escape `[`, `]` and `\` in link text.
- `status-change` shows only the changed field (status / message) with VRChat names (Online / Join Me / Ask Me / Do Not Disturb), and hides the status field when the previous status is unrecorded.

## Notification and persistence invariants

- Keep `schemaVersion` at `3`. A schema 3 file without `outbox` loads as an empty outbox. Schema 2, broken JSON and invalid state / outbox are never discarded automatically: startup is refused, the original data is preserved, and an administrator restores a healthy backup or explicitly chooses a new baseline. An absent store (and only that) starts empty.
- The configuration and the time at reception stay fixed while retrying. The main effect / followUp `current` also carries the final profile observed at the same time. CEL time conditions and the Embed time use the outbox `createdAt`, never the send time. Display-name completion uses the state at processing time.
- Store the pending notification and the state in the same atomic mutation. Persist the per-destination payload before the POST, `sending` before sending and `delivered` after success; a `sending` left over at restart becomes `uncertain`.
- `blocked` (permanent failure) and `uncertain` (delivery unknown) are never retried automatically. Later events of the same user wait until the head event is complete. A Discord POST and a local write cannot share a transaction, so exactly-once delivery is not guaranteed. 429 / 5xx are retried with limits.
- `pnpm outbox ...` runs only while the app is stopped (it must be rejected when the app holds the lock). `retry` is an explicit administrator action that accepts possible duplicates; `discard` finishes the given destination only and does not roll back other destinations. `retry` without a destination re-evaluates a preparation failure; `discard` without a destination drops the whole event.
- Health: an incomplete baseline is `unhealthy`; REST synchronization or delivery problems, blocked / uncertain notifications and a notification pending for more than 60 seconds are `degraded`. A null synchronization result is never evidence of ready. Overflow is kept as an anomaly even after persistence recovers.
- Shutdown: stop receiving first, then wait up to 5 seconds each for the coordinator and delivery. Keep stored pending notifications, abort network calls and flush state / cookies / caches. Exit abnormally when main's 15-second deadline is exceeded.
- CEL failures, Worker timeouts and world lookup failures must not suppress notifications of unrelated rules. A failed configuration reload keeps running on the last known good configuration.

## Testing

- Jest (`ts-jest`), tests in `**/*.test.ts` covering config, rules, state, vrchat, notifications, health and app. Run `pnpm test`.
- Before committing, make sure `pnpm lint` passes.
