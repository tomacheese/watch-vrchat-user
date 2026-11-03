import { Logger } from '@book000/node-utils'
import { isTraveling } from '../state/location'
import type { Profile } from '../state/user-state'
import type { UserStateCoordinator } from '../state/user-state-coordinator'

const logger = Logger.configure('PIPELINE-EVENT-ROUTER')

/** Minimal interface an EventEmitter that fires Pipeline business events must satisfy */
export interface PipelineEventEmitterLike {
  on: (event: string, listener: (data: unknown) => void) => void
  removeAllListeners: (event: string) => void
  removeListener?: (event: string, listener: (data: unknown) => void) => void
}

/** Payload of the Pipeline `friend-location` event */
interface FriendLocationEvent {
  userId: string
  user: { id: string; displayName: string }
  location: string
}

/** Payload of the Pipeline `friend-online` event */
interface FriendOnlineEvent {
  userId: string
  user: { id: string; displayName: string }
  /** Optional. Included in the online observation only when it is a usable value */
  location?: unknown
}

/** Payload of the Pipeline `friend-add` event (shape is assumed; not verified against a real device/API) */
interface FriendAddEvent {
  userId: string
  user: { id: string; displayName: string }
}

/** Payload of the Pipeline `friend-delete` event (shape is assumed; not verified against a real device/API) */
interface FriendDeleteEvent {
  userId: string
}

/** Payload of the Pipeline `friend-offline` event */
interface FriendOfflineEvent {
  userId: string
}

/**
 * Extracts the status and status message from the payload's user.
 *
 * @param user The payload's user object
 * @returns A Profile only if both are strings, otherwise undefined
 */
function extractProfile(user: unknown): Profile | undefined {
  if (typeof user !== 'object' || user === null) return undefined
  const { status, statusDescription } = user as Record<string, unknown>
  return typeof status === 'string' && typeof statusDescription === 'string'
    ? { status, statusDescription }
    : undefined
}

/**
 * Validates that the event data is a valid FriendLocationEvent.
 *
 * @param data Data to validate
 * @returns True if valid
 */
function isFriendLocationEvent(data: unknown): data is FriendLocationEvent {
  if (typeof data !== 'object' || data === null) return false
  const obj = data as Record<string, unknown>
  if (typeof obj.userId !== 'string' || typeof obj.location !== 'string')
    return false
  if (typeof obj.user !== 'object' || obj.user === null) return false
  const user = obj.user as Record<string, unknown>
  return typeof user.id === 'string' && typeof user.displayName === 'string'
}

/**
 * Validates that the event data is a valid FriendOnlineEvent.
 *
 * @param data Data to validate
 * @returns True if valid
 */
function isFriendOnlineEvent(data: unknown): data is FriendOnlineEvent {
  if (typeof data !== 'object' || data === null) return false
  const obj = data as Record<string, unknown>
  if (typeof obj.userId !== 'string') return false
  if (typeof obj.user !== 'object' || obj.user === null) return false
  const user = obj.user as Record<string, unknown>
  return typeof user.id === 'string' && typeof user.displayName === 'string'
}

/**
 * Determines whether a friend-online location can be put on the online observation.
 *
 * @param location The payload's location
 * @returns True for a usable Location string
 */
function isUsableLocation(location: unknown): location is string {
  return (
    typeof location === 'string' &&
    location !== '' &&
    location !== 'offline' &&
    !isTraveling(location)
  )
}

/**
 * Validates that the event data is a valid FriendOfflineEvent.
 *
 * @param data Data to validate
 * @returns True if valid
 */
function isFriendOfflineEvent(data: unknown): data is FriendOfflineEvent {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as Record<string, unknown>).userId === 'string'
  )
}

/**
 * Validates that the event data is a valid FriendAddEvent.
 *
 * @param data Data to validate
 * @returns True if valid
 */
function isFriendAddEvent(data: unknown): data is FriendAddEvent {
  // Requires the same shape as friend-online (userId + user.id + user.displayName)
  return isFriendOnlineEvent(data)
}

/**
 * Validates that the event data is a valid FriendDeleteEvent.
 *
 * @param data Data to validate
 * @returns True if valid
 */
function isFriendDeleteEvent(data: unknown): data is FriendDeleteEvent {
  return isFriendOfflineEvent(data)
}

/**
 * Normalizes Pipeline business events into UserObservations and enqueues them to the Coordinator.
 *
 * It does not handle liveness (raw messages are handled by PipelineTransportAdapter).
 */
export class PipelineEventRouter {
  private pipeline: PipelineEventEmitterLike | undefined
  private readonly listeners = new Map<string, (data: unknown) => void>()

  /**
   * Creates a PipelineEventRouter.
   *
   * @param coordinator Destination for enqueued observations
   */
  constructor(private readonly coordinator: UserStateCoordinator) {}

  /**
   * Registers business event listeners on the Pipeline's EventEmitter.
   *
   * @param pipeline The VRChat SDK's pipeline EventEmitter
   */
  attach(pipeline: PipelineEventEmitterLike): void {
    this.detach()
    this.pipeline = pipeline

    this.listen('friend-location', (data: unknown) => {
      if (!isFriendLocationEvent(data)) {
        logger.error('Invalid friend-location event data')
        return
      }
      this.coordinator.enqueue(data.userId, data.user.displayName, {
        type: 'location',
        location: data.location,
        profile: extractProfile(data.user),
      })
    })

    this.listen('friend-online', (data: unknown) => {
      if (!isFriendOnlineEvent(data)) {
        logger.error('Invalid friend-online event data')
        return
      }
      this.coordinator.enqueue(
        data.userId,
        data.user.displayName,
        isUsableLocation(data.location)
          ? {
              type: 'online',
              location: data.location,
              profile: extractProfile(data.user),
            }
          : { type: 'online', profile: extractProfile(data.user) }
      )
    })

    this.listen('friend-offline', (data: unknown) => {
      if (!isFriendOfflineEvent(data)) {
        logger.error('Invalid friend-offline event data')
        return
      }
      // displayName is filled in from the Repository's existing value by Coordinator.enqueue
      this.coordinator.enqueue(data.userId, data.userId, { type: 'offline' })
    })

    this.listen('friend-add', (data: unknown) => {
      if (!isFriendAddEvent(data)) {
        logger.error('Invalid friend-add event data')
        return
      }
      this.coordinator.enqueue(data.userId, data.user.displayName, {
        type: 'friend-add',
      })
    })

    this.listen('friend-delete', (data: unknown) => {
      if (!isFriendDeleteEvent(data)) {
        logger.error('Invalid friend-delete event data')
        return
      }
      // displayName is filled in from the Repository's existing value by Coordinator.enqueue
      this.coordinator.enqueue(data.userId, data.userId, {
        type: 'friend-delete',
      })
    })

    // friend-update arrives for any profile update; payloads carrying status / statusDescription are verified on a live account
    this.listen('friend-update', (data: unknown) => {
      const profile = isFriendOnlineEvent(data)
        ? extractProfile(data.user)
        : undefined
      if (profile === undefined || !isFriendOnlineEvent(data)) {
        logger.debug('Ignored friend-update event without status')
        return
      }
      this.coordinator.enqueue(data.userId, data.user.displayName, {
        type: 'profile',
        profile,
      })
    })
  }

  /** Removes the registered business event listeners */
  detach(): void {
    const pipeline = this.pipeline
    if (!pipeline) return
    for (const [event, listener] of this.listeners) {
      if (pipeline.removeListener) pipeline.removeListener(event, listener)
      else pipeline.removeAllListeners(event)
    }
    this.listeners.clear()
    this.pipeline = undefined
  }

  /**
   * Records a listener owned by the router and registers it.
   *
   * @param event Business event name
   * @param listener Handler that normalizes the payload
   */
  private listen(event: string, listener: (data: unknown) => void): void {
    this.listeners.set(event, listener)
    this.pipeline?.on(event, listener)
  }
}
