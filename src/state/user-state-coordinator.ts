import { Logger } from '@book000/node-utils'
import type { ConfigSnapshot } from '../config/config-snapshot'
import type { PersistedEffect } from '../notifications/outbox-types'
import { toError } from '../logger-utils'
import { parseLocation } from './location'
import type { UserState } from './user-state'
import {
  reduce,
  type ReducerEffect,
  type UserObservation,
} from './user-state-reducer'
import type { UserStateRepository } from './user-state-repository'

const logger = Logger.configure('USER-STATE-COORDINATOR')

/** Unhealthy state information */
export interface UnhealthyInfo {
  /** Cause of the unhealthy state */
  cause: string
  /** When it became unhealthy (ISO 8601) */
  since: string
}

/** Options tuning Coordinator behavior (for tests) */
export interface UserStateCoordinatorOptions {
  /** Initial retry interval on persist failure (ms) */
  initialBackoffMs?: number
  /** Maximum retry interval on persist failure (ms) */
  maxBackoffMs?: number
  /** Maximum queue length per user */
  maxQueueSize?: number
  /** Converts effects into a form that can be persisted together with state */
  prepareEffects?: (
    userId: string,
    displayName: string,
    effects: Exclude<ReducerEffect, { type: 'no-op' }>[],
    snapshot: ConfigSnapshot,
    receivedAt?: string
  ) => PersistedEffect[]
  /** Wakes processing of persisted notifications */
  onCommitted?: () => void
}

/** One observation queued in a per-user queue */
interface QueueItem {
  /** Display name (filled in at processing time when it equals the user ID) */
  displayName: string
  /** Observation */
  observation: UserObservation
  /** Config snapshot at enqueue time (used for evaluation even across a reload) */
  snapshot: ConfigSnapshot
  /** Whether the baseline was being built at enqueue time (no notification effects while true) */
  baseline: boolean
  /** Receive time. Unchanged by persist retries or delivery delays */
  receivedAt: string
}

/**
 * Summarizes state for logs (never prints the raw Location, which may contain a nonce)
 * Non-private invisible Locations are reported as hidden so unexpected values are not echoed
 *
 * @param state State to summarize
 * @returns String of the form `presence/world:instanceType`
 */
function describeState(state: UserState | undefined): string {
  if (state === undefined) return 'none'
  const parsed = parseLocation(state.location)
  const location = parsed.visible
    ? `${parsed.worldId}:${parsed.instance.type}`
    : state.location === 'private'
      ? 'private'
      : 'hidden'
  return `${state.presence}/${location}`
}

const DEFAULT_INITIAL_BACKOFF_MS = 1000
const DEFAULT_MAX_BACKOFF_MS = 300_000
const DEFAULT_MAX_QUEUE_SIZE = 1000

/**
 * Single-writer queue that processes observations serially per user
 *
 * Persists across transport connection generations. REST snapshots are appended via
 * `appendSnapshotObservation` compare-and-enqueue without replacing WebSocket
 * observations that were already received.
 */
export class UserStateCoordinator {
  private readonly queues = new Map<string, QueueItem[]>()
  private readonly processing = new Set<string>()
  private readonly lastSeq = new Map<string, number>()
  private readonly unhealthy = new Map<string, UnhealthyInfo>()
  private accepting = true
  private stopping = false
  private readonly retryWaiters = new Set<() => void>()
  private readonly drainWaiters = new Set<() => void>()
  private readonly initialBackoffMs: number
  private readonly maxBackoffMs: number
  private readonly maxQueueSize: number

  /**
   * Initializes the UserStateCoordinator
   *
   * @param repository Repository to persist to
   * @param onEffect Callback invoked when a reduce result effect is not a no-op (with the config snapshot attached to the item)
   * @param getSnapshot Function returning the config snapshot at enqueue time
   * @param options Options such as retry intervals and queue limit
   */
  constructor(
    private readonly repository: UserStateRepository,
    private readonly onEffect: (
      userId: string,
      displayName: string,
      effect: ReducerEffect,
      snapshot: ConfigSnapshot
    ) => Promise<void>,
    private readonly getSnapshot: () => ConfigSnapshot,
    private readonly options: UserStateCoordinatorOptions = {}
  ) {
    this.initialBackoffMs =
      options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE
  }

  /**
   * Adds an observation to the queue and starts the processing loop if it is stopped
   *
   * When `displayName` equals `userId` (the caller has no display name, so it is a
   * fallback), it is filled in at processing time from the display name the Repository holds.
   *
   * The config snapshot and baseline flag are fixed at enqueue time and attached to the item.
   *
   * When the queue is full, the observation is dropped silently and the user is marked unhealthy
   * (known limitation: the final state after a dropped intermediate transition can
   * only be corrected by REST reconciliation).
   *
   * @param userId User ID
   * @param displayName Display name
   * @param observation Observation
   */
  enqueue(
    userId: string,
    displayName: string,
    observation: UserObservation
  ): void {
    if (!this.accepting) return

    this.lastSeq.set(userId, (this.lastSeq.get(userId) ?? 0) + 1)

    const queue = this.queues.get(userId) ?? []
    this.queues.set(userId, queue)

    if (queue.length >= this.maxQueueSize) {
      this.markUnhealthy(userId, 'queue-overflow')
      logger.error(
        `Queue overflow for user ${userId}, dropping new observation`
      )
      return
    }

    queue.push({
      displayName,
      observation,
      snapshot: this.getSnapshot(),
      baseline: !this.repository.isBaselineCompleted(),
      receivedAt: new Date().toISOString(),
    })
    this.startProcessingQueue(userId)
  }

  /** Stops accepting new observations */
  stopAccepting(): void {
    this.accepting = false
  }

  /**
   * Processes the remaining queue within the deadline; persist failures during shutdown are not retried
   *
   * @param timeoutMs Time limit for shutdown processing
   * @returns true if all observations were processed
   */
  async stop(timeoutMs = 10_000): Promise<boolean> {
    this.stopAccepting()
    this.stopping = true
    for (const wake of this.retryWaiters) wake()
    let timer: NodeJS.Timeout | undefined
    let timedOut = false
    const finished = async (): Promise<boolean> => {
      while (this.processing.size > 0) {
        if (timedOut) return false
        await new Promise<void>((resolve) => {
          this.drainWaiters.add(resolve)
        })
      }
      return (
        !timedOut &&
        this.queues.values().every((queue) => queue.length === 0) &&
        this.unhealthy.values().every((info) => info.cause !== 'queue-overflow')
      )
    }
    try {
      return await Promise.race([
        finished(),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true
            this.notifyDrainWaiters()
            resolve(false)
          }, timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Gets the seq at the tail of the current queue (used as an anchor before starting a REST snapshot fetch)
   *
   * @param userId User ID
   * @returns Current seq (0 if nothing was enqueued)
   */
  captureSeq(userId: string): number {
    return this.lastSeq.get(userId) ?? 0
  }

  /**
   * Copies the current seq of all users (used as an anchor before starting a REST snapshot fetch)
   *
   * Includes users without a record (e.g. only traveling WebSocket events received).
   *
   * @returns Read-only Map from user ID to seq (users never enqueued are not included)
   */
  captureAllSeqs(): ReadonlyMap<string, number> {
    return new Map(this.lastSeq)
  }

  /**
   * Appends a REST snapshot via compare-and-enqueue
   *
   * Appends only if `expectedSeq` matches the current seq. If a newer WebSocket
   * observation arrived during the REST call, nothing is appended and false is returned
   * so newer real data is not overwritten by an older REST snapshot.
   *
   * @param userId User ID
   * @param displayName Display name
   * @param observation Observation from REST
   * @param expectedSeq Anchor seq obtained from `captureSeq`
   * @returns true if appended, false if dropped as stale
   */
  appendSnapshotObservation(
    userId: string,
    displayName: string,
    observation: UserObservation,
    expectedSeq: number
  ): boolean {
    if ((this.lastSeq.get(userId) ?? 0) !== expectedSeq) {
      return false
    }
    if (
      !this.accepting ||
      (this.queues.get(userId)?.length ?? 0) >= this.maxQueueSize
    ) {
      if (this.accepting) this.markUnhealthy(userId, 'queue-overflow')
      return false
    }
    this.enqueue(userId, displayName, observation)
    return true
  }

  /**
   * Waits until the queues of the given users are fully processed
   *
   * If any of the users becomes unhealthy (persist-failure / queue-overflow) while waiting,
   * completion cannot be guaranteed, so false is returned immediately.
   *
   * @param userIds User IDs to wait for
   * @returns true if all queues became empty, false if an unhealthy user was detected
   */
  async drain(userIds: string[]): Promise<boolean> {
    while (true) {
      if (userIds.some((userId) => this.unhealthy.has(userId))) {
        return false
      }
      if (userIds.every((userId) => this.isIdle(userId))) {
        return true
      }
      await new Promise<void>((resolve) => {
        this.drainWaiters.add(resolve)
      })
    }
  }

  /**
   * Returns whether the user's queue is empty and the processing loop is idle
   *
   * @param userId User ID
   * @returns true if nothing is being processed
   */
  private isIdle(userId: string): boolean {
    return (
      (this.queues.get(userId)?.length ?? 0) === 0 &&
      !this.processing.has(userId)
    )
  }

  /** Wakes drain waiters so they re-evaluate their condition */
  private notifyDrainWaiters(): void {
    const waiters = [...this.drainWaiters]
    this.drainWaiters.clear()
    for (const resolve of waiters) {
      resolve()
    }
  }

  /**
   * Gets unhealthy information for the user
   *
   * @param userId User ID
   * @returns Unhealthy information, or undefined if healthy
   */
  getUnhealthy(userId: string): UnhealthyInfo | undefined {
    return this.unhealthy.get(userId)
  }

  /**
   * Gets unhealthy information for all unhealthy users
   *
   * @returns Map of unhealthy information keyed by user ID
   */
  getAllUnhealthy(): Record<string, UnhealthyInfo> {
    return Object.fromEntries(this.unhealthy)
  }

  /**
   * Processes the user's queue in order from the head
   *
   * An observation that fails to persist stays at the queue head and is
   * retried indefinitely with capped exponential backoff.
   *
   * @param userId User ID
   */
  private async processQueue(userId: string): Promise<void> {
    if (this.processing.has(userId)) {
      return
    }
    this.processing.add(userId)

    try {
      let attempt = 0
      while (true) {
        const queue = this.queues.get(userId)
        if (!queue || queue.length === 0) {
          return
        }

        const item = queue[0]
        const current = this.repository.get(userId)
        const displayName =
          item.displayName === userId
            ? (current?.displayName ?? item.displayName)
            : item.displayName
        const { nextState, deleteUser, effect, followUp, statusEffect } =
          reduce(userId, current, displayName, item.observation, item.baseline)

        try {
          const effects = [effect, followUp, statusEffect].filter(
            (value): value is Exclude<ReducerEffect, { type: 'no-op' }> =>
              value !== undefined && value.type !== 'no-op'
          )
          const pending = this.options.prepareEffects?.(
            userId,
            displayName,
            effects,
            item.snapshot,
            item.receivedAt
          )
          if (deleteUser) {
            await this.repository.deleteUser(userId, pending)
          } else if (nextState && nextState !== current) {
            await this.repository.commitUserState(
              userId,
              {
                ...nextState,
                userId,
              },
              pending
            )
          }
          if (deleteUser || (nextState && nextState !== current)) {
            logger.info(
              `State changed: user=${userId} (${displayName}) ${describeState(current)} -> ${describeState(nextState)} effects=${[effect, followUp, statusEffect].flatMap((e) => (e && e.type !== 'no-op' ? e.type : [])).join(',') || 'none'}${item.baseline ? ' baseline' : ''}`
            )
          }
          queue.shift()
          attempt = 0
          // queue-overflow is permanent data loss (the observation cannot be recovered), so the record is
          // kept even if later commits succeed (persist-failure is recoverable, so it can be cleared)
          if (this.unhealthy.get(userId)?.cause === 'persist-failure') {
            this.unhealthy.delete(userId)
          }

          if (this.options.prepareEffects) {
            try {
              this.options.onCommitted?.()
            } catch (error) {
              logger.error('Failed to wake notification outbox', toError(error))
            }
            continue
          }
          for (const e of [effect, followUp, statusEffect]) {
            if (e === undefined || e.type === 'no-op') continue
            await this.onEffect(userId, displayName, e, item.snapshot).catch(
              (error: unknown) => {
                // A notification failure is only logged. The state is already committed,
                // so the notification is not resent and processing continues with the next observation.
                logger.error(
                  `Failed to dispatch effect for user ${userId}`,
                  toError(error)
                )
              }
            )
          }
        } catch (error) {
          this.markUnhealthy(userId, 'persist-failure')
          logger.error(
            `Failed to persist state for user ${userId}`,
            toError(error)
          )
          if (this.stopping) return
          const delay = Math.min(
            this.initialBackoffMs * 2 ** attempt,
            this.maxBackoffMs
          )
          attempt += 1
          await this.sleep(delay)
        }
      }
    } finally {
      this.processing.delete(userId)
      this.notifyDrainWaiters()
      // An enqueue during sleep may have added an item right after the loop exited,
      // so restart the processing loop if the queue is not empty
      const queue = this.queues.get(userId)
      if (queue && !this.stopping && queue.length > 0) {
        this.startProcessingQueue(userId)
      }
    }
  }

  /**
   * Starts `processQueue` fire-and-forget
   *
   * This repository's ESLint config forbids `no-void`, so `no-floating-promises`
   * is satisfied with this explicit `.catch` wrapper instead of `void`.
   *
   * @param userId User ID
   */
  private startProcessingQueue(userId: string): void {
    this.processQueue(userId).catch((error: unknown) => {
      logger.error(
        `Unexpected error while processing queue for user ${userId}`,
        toError(error)
      )
    })
  }

  /**
   * Marks the user as unhealthy (an unrecoverable overflow takes precedence)
   *
   * @param userId User ID
   * @param cause Cause of the unhealthy state
   */
  private markUnhealthy(userId: string, cause: string): void {
    const previous = this.unhealthy.get(userId)
    if (
      previous &&
      (cause !== 'queue-overflow' || previous.cause === 'queue-overflow')
    ) {
      return
    }
    this.unhealthy.set(userId, { cause, since: new Date().toISOString() })
    this.notifyDrainWaiters()
  }

  /**
   * Waits for the given number of milliseconds
   *
   * @param ms Milliseconds to wait
   */
  private async sleep(ms: number): Promise<void> {
    if (this.stopping) return
    await new Promise<void>((resolve) => {
      const retry: { timer?: NodeJS.Timeout } = {}
      const wake = (): void => {
        clearTimeout(retry.timer)
        this.retryWaiters.delete(wake)
        resolve()
      }
      retry.timer = setTimeout(wake, ms)
      this.retryWaiters.add(wake)
    })
  }
}
