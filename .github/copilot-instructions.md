# GitHub Copilot code review instructions

Project overview, architecture, conventions and the persistence / notification invariants are in [AGENTS.md](../AGENTS.md). Review against those rules; this file lists only what to focus on and what not to flag.

## Review focus

- Secret leaks: VRChat credentials, TOTP secret, cookies, Location nonces and Discord webhook URLs (including expanded `destinations` values) must not reach logs, error messages or commits.
- Error handling: WebSocket disconnects / reconnects, VRChat API failures and authentication errors must not be swallowed; the `pipeline-supervisor.ts` state transitions (`connecting` / `synchronizing` / `ready` / `reconnecting` / `stopped`) and connection generation handling must stay consistent.
- Duplicate suppression: `user-state-reducer.ts` must compare against the previous value; `traveling` must not leak into notifications or persistence; `status-change` must not record the `offline` status or notify on the first observation of a field.
- Type safety: no new `any`, no `skipLibCheck`, proper typing of SDK / WebSocket payloads.
- Rule isolation: CEL failures, Worker timeouts and world lookup failures must not stop unrelated rules; CEL is evaluated in an isolated Worker with execution time, startup time, cache and heap limits; a failed reload must keep the last known good configuration.
- Persistence safety: an empty state only when the store is absent; never overwrite corrupt or unsupported data; JSON to SQLite one-time migration, state + outbox transactions, config snapshot dedupe, `0600` permissions and the OS-level writer lock stay intact; an old schema 3 file with an optional outbox must still migrate; schema 2 is never discarded automatically.
- Delivery integrity: state commit and outbox save in one mutation; the coordinator never waits for the network; `sending` becomes `uncertain` after a restart; permanent 4xx is `blocked`, unknown delivery is `uncertain`, neither is retried automatically; 429 / 5xx retries are bounded; per-user order is preserved, so a later event of a user must never overtake an incomplete head event.
- Reception-time semantics: raw CEL and expanded destinations are stored at acceptance; CEL time uses the stored `createdAt`; the final observed profile is in the online / Location effect.
- Operations: baseline incomplete is `unhealthy`; sync / delivery failures and notifications pending 60 seconds or more are `degraded`; shutdown stops intake, drains with a deadline and flushes; the outbox CLI rejects a concurrent writer; session re-authentication works, network calls are aborted on shutdown, and the world cache shares its first load, caps entries and writes in batches; queue overflow is never cleared by persistence recovery alone.

## Enforced conventions

- Prettier (`pnpm lint:prettier`), ESLint with `@book000/eslint-config` (`pnpm lint:eslint`), `tsc` with `strict` (`pnpm lint:tsc`).
- English comments, JSDoc and log / error messages; Conventional Commits.
- `.env` must be loaded before modules that read configuration or cookie paths.

## Known patterns not to flag

- `keyv-file` for local cookie persistence (design choice).
- The outbox keeping expanded webhook URLs, raw CEL and Embeds in a `0600` SQLite store for recovery (do flag leaks to logs, health or CLI listings).
- Uncertain deliveries waiting for an administrator `retry` / `discard` instead of automatic retry; exactly-once delivery is not guaranteed.
- The patch applied to the `vrchat` package (works around an SDK typing bug).
- The interactive 2FA prompt in `vrchat/session.ts` when no TOTP secret is configured.
- The router ignoring `friend-update` payloads whose `status` / `statusDescription` are not strings (intended; the payload shape was verified on a real account).
- `status-change` for a message change when the status was never recorded (judged per field).
- Friends API snapshot profiles only initializing unconfirmed fields and never producing `status-change`.
- The health server listening on localhost only.

## Tests

Jest (`pnpm test`). Expect tests following the existing patterns for new logic.
