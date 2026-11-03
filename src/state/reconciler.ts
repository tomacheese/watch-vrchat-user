import { Logger } from '@book000/node-utils'
import type { VRChat } from 'vrchat'
import { toError } from '../logger-utils'
import { getFriendsSnapshot, isFriend } from '../vrchat/session'
import type { Profile } from './user-state'
import { isTraveling } from './location'
import type { UserStateCoordinator } from './user-state-coordinator'
import type { UserObservation } from './user-state-reducer'
import type { UserState } from './user-state'
import type { UserStateRepository } from './user-state-repository'

const logger = Logger.configure('RECONCILER')

/** Cooldown after a 429 error (ms) */
const RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000

/**
 * Converts a Friends API location into an observation
 *
 * @param location Friends API location
 * @param profile Friends API status and status message
 * @returns Observation. `traveling` confirms only presence (the location stays unconfirmed)
 */
function toObservation(location: string, profile?: Profile): UserObservation {
  const profileObservation =
    profile === undefined ? {} : { profile, profileBaseline: true }
  if (isTraveling(location)) return { type: 'online', ...profileObservation }
  return location === 'offline'
    ? { type: 'offline', ...profileObservation }
    : { type: 'location', location, ...profileObservation }
}

/**
 * Determines whether an observation disagrees with the existing state
 *
 * A mismatch found by REST sync indicates a difference that did not arrive over WebSocket.
 *
 * @param current Existing state (undefined for an unknown user, which is not counted as a mismatch)
 * @param observation Observation derived from the REST snapshot
 * @returns true if they disagree
 */
function differsFromState(
  current: UserState | undefined,
  observation: UserObservation
): boolean {
  if (current === undefined) return false
  if (observation.type === 'offline') return current.presence !== 'offline'
  return observation.type === 'location'
    ? current.presence !== 'online' || current.location !== observation.location
    : current.presence !== 'online'
}

/**
 * Fetches a Friends API REST snapshot and appends it to the
 * UserStateCoordinator queue via compare-and-enqueue
 *
 * The same logic is used on startup, after reconnect, and for periodic polling.
 * A REST mismatch alone never triggers a reconnect.
 */
export class Reconciler {
  private lastRunAt: Date | null = null
  private cooldownUntil: Date | null = null
  private inFlight: Promise<number | null> | undefined
  private stopped = false
  private lastError: string | null = null

  /**
   * Initializes the Reconciler
   *
   * @param getVrchat Function returning the current VRChat client (null when not connected)
   * @param coordinator Destination queue for observations
   * @param repository Source of known users and the baseline-completed flag, and where they are persisted
   */
  constructor(
    private readonly getVrchat: () => VRChat | null,
    private readonly coordinator: UserStateCoordinator,
    private readonly repository: UserStateRepository
  ) {}

  /**
   * Gets the time of the last reconcile run
   *
   * @returns Run time, or null if never run
   */
  getLastRunAt(): Date | null {
    return this.lastRunAt
  }

  /**
   * Fetches a REST snapshot of all friends and appends it to the queue
   *
   * If fetching even one page of the snapshot fails, no differences are applied.
   *
   * @returns Drift count (differences that did not arrive over WebSocket) when sync completed.
   * null when sync could not be confirmed (not connected, cooling down, 429, fetch failure, etc.)
   */
  async reconcileAll(): Promise<number | null> {
    if (this.stopped) return null
    this.inFlight ??= this.runReconciliation().finally(() => {
      this.inFlight = undefined
    })
    return this.inFlight
  }

  /** Also detects a stop requested while awaiting asynchronous REST calls */
  private isStopped(): boolean {
    return this.stopped
  }

  /** Stops new syncs. Session aborts any in-flight REST calls */
  stop(): void {
    this.stopped = true
  }

  /** @returns The last sync failure. External responses are not exposed */
  getLastError(): string | null {
    return this.lastError
  }

  /** Runs one sync */
  private async runReconciliation(): Promise<number | null> {
    const vrchat = this.getVrchat()
    if (!vrchat) {
      this.lastError = 'VRChat client is unavailable'
      logger.warn('VRChat client is not initialized, skipping reconciliation')
      return null
    }

    if (this.cooldownUntil && new Date() < this.cooldownUntil) {
      this.lastError = 'Reconciliation is waiting for rate limit cooldown'
      logger.info('Skipping reconciliation due to rate limit cooldown')
      return null
    }
    this.cooldownUntil = null

    try {
      const drift = await this.reconcile(vrchat)
      this.lastError = null
      return drift
    } catch (error) {
      this.lastError = 'Friends reconciliation failed'
      if (error instanceof Error && error.message.includes('429')) {
        this.cooldownUntil = new Date(Date.now() + RATE_LIMIT_COOLDOWN_MS)
        logger.warn(
          `API rate limit error (429), cooling down for ${RATE_LIMIT_COOLDOWN_MS / 1000 / 60} minutes`
        )
        return null
      }
      logger.error('Error reconciling friends', toError(error))
      return null
    }
  }

  /**
   * Fetches the snapshot, enqueues differences, and persists baseline completion
   *
   * @param vrchat VRChat client
   * @returns Drift count
   */
  private async reconcile(vrchat: VRChat): Promise<number> {
    // Record every user's seq before fetching (including users without a record). Unobserved counts as seq 0
    const knownUsers = Object.values(this.repository.getAll())
    const expectedSeqs = this.coordinator.captureAllSeqs()

    const snapshot = await getFriendsSnapshot(vrchat)
    if (this.stopped) throw new Error('Reconciliation stopped')
    this.lastRunAt = new Date()

    const touchedUserIds: string[] = []
    let drift = 0
    for (const [userId, friend] of snapshot) {
      touchedUserIds.push(userId)
      const observation = toObservation(friend.location, friend.profile)
      const differs = differsFromState(this.repository.get(userId), observation)
      const appended = this.appendOrDrop(
        userId,
        friend.displayName,
        observation,
        expectedSeqs.get(userId) ?? 0
      )
      if (appended && differs) drift++
    }
    // Count of differences that did not arrive over WebSocket (for investigating disconnect causes)
    logger.info(
      `Reconciliation snapshot applied: friends=${snapshot.size} drift=${drift}`
    )

    for (const user of knownUsers) {
      if (snapshot.has(user.userId)) continue
      if (!(await this.isConfirmedDeleted(vrchat, user.userId))) continue
      if (this.isStopped()) throw new Error('Reconciliation stopped')
      touchedUserIds.push(user.userId)
      this.appendOrDrop(
        user.userId,
        user.displayName,
        { type: 'friend-delete' },
        expectedSeqs.get(user.userId) ?? 0
      )
    }

    if (!this.repository.isBaselineCompleted()) {
      await this.completeBaseline(touchedUserIds)
    }
    return drift
  }

  /**
   * Returns whether the API confirmed that the user is not a friend
   *
   * Returns false if the check API fails, since "not a friend" cannot be concluded.
   * Only 429 is propagated to the caller for cooldown handling.
   *
   * @param vrchat VRChat client
   * @param userId User ID to check
   * @returns true if confirmed not a friend
   */
  private async isConfirmedDeleted(
    vrchat: VRChat,
    userId: string
  ): Promise<boolean> {
    try {
      return !(await isFriend(vrchat, userId))
    } catch (error) {
      if (error instanceof Error && error.message.includes('429')) {
        throw error
      }
      logger.error(
        `Failed to confirm friend status for ${userId}`,
        toError(error)
      )
      return false
    }
  }

  /**
   * Compare-and-enqueues an observation and logs when it is dropped as stale
   *
   * @param userId User ID
   * @param displayName Display name
   * @param observation Observation to enqueue
   * @param expectedSeq Seq recorded before fetching
   * @returns true if enqueued, false if dropped as stale
   */
  private appendOrDrop(
    userId: string,
    displayName: string,
    observation: UserObservation,
    expectedSeq: number
  ): boolean {
    const appended = this.coordinator.appendSnapshotObservation(
      userId,
      displayName,
      observation,
      expectedSeq
    )
    if (!appended) {
      logger.info(
        `Snapshot for user ${userId} is stale, dropped (newer WebSocket observation arrived)`
      )
    }
    return appended
  }

  /**
   * Waits for all baseline observations to persist and persists the completed flag only on success
   *
   * If draining returns false due to a persist failure or queue overflow, nothing is persisted
   * and the next reconcile retries.
   *
   * @param userIds User IDs to wait for
   */
  private async completeBaseline(userIds: string[]): Promise<void> {
    const drained = await this.coordinator.drain(userIds)
    if (!drained) {
      logger.warn(
        'Baseline was not completed because some users are unhealthy, will retry on next reconciliation'
      )
      throw new Error('Baseline could not be completed')
    }
    await this.repository.setBaselineCompleted()
    logger.info('Baseline completed')
  }
}
