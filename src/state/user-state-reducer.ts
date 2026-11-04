import { isTraveling, parseLocation } from './location'
import type { Presence, Profile, UserState } from './user-state'

/** Observation normalized from a WebSocket event / REST snapshot. profileBaseline keeps snapshot values from triggering transition notifications */
export type UserObservation =
  | {
      type: 'online'
      location?: string
      profile?: Profile
      profileBaseline?: boolean
    }
  | { type: 'offline'; profile?: Profile; profileBaseline?: boolean }
  | {
      type: 'location'
      location: string
      profile?: Profile
      profileBaseline?: boolean
    }
  | { type: 'friend-add'; profile?: Profile; profileBaseline?: boolean }
  | { type: 'friend-delete' }
  | { type: 'profile'; profile: Profile; profileBaseline?: boolean }

/** Semantic event types to notify about */
export type SemanticEventType =
  | 'online'
  | 'offline'
  | 'location-change'
  | 'friend-add'
  | 'friend-delete'
  | 'status-change'

/**
 * Semantic effect for notification produced by the reducer
 *
 * `previous` is undefined for `friend-add` and `current` is undefined for `friend-delete`.
 */
export type ReducerEffect =
  | { type: 'no-op' }
  | {
      type: SemanticEventType
      previous: UserState | undefined
      current: UserState | undefined
    }

/** Result of reduce */
export interface ReduceResult {
  /** Updated state. undefined when there is not enough information to record anything, or the record is to be deleted */
  nextState: UserState | undefined
  /** Whether the record should be removed from state (`friend-delete` for an existing record) */
  deleteUser: boolean
  /** Notification effect to fire */
  effect: ReducerEffect
  /** Effect fired after `effect` (the `location-change` when a Location is confirmed together with going online) */
  followUp?: ReducerEffect
  /** `status-change` when the status or status message changed (can occur together with other effects) */
  statusEffect?: ReducerEffect
}

/**
 * Presence and location to record, derived from an observation
 */
interface Target {
  presence: Presence
  /** undefined means "keep the current location" */
  location: string | null | undefined
}

/**
 * Derives the updated presence / location from an observation
 *
 * @param observation Observation other than friend-add / friend-delete
 * @returns Updated presence / location
 */
function resolveTarget(
  observation: Exclude<
    UserObservation,
    { type: 'friend-add' } | { type: 'friend-delete' } | { type: 'profile' }
  >
): Target {
  // The location of an online observation is optional. traveling is not a confirmed value, so it is ignored
  return observation.type === 'offline'
    ? { presence: 'offline', location: null }
    : {
        presence: 'online',
        location:
          observation.location === undefined ||
          (observation.type === 'online' && isTraveling(observation.location))
            ? undefined
            : observation.location,
      }
}

/**
 * Determines whether a location change while online should be a location-change
 *
 * Applies when the new location is visible and the previous one is confirmed (visible or private).
 * When the new location is private, applies only if the previous one was visible (staying private or going private from unconfirmed does not apply).
 * When the previous location is unconfirmed (null), location-change is emitted only via pending.
 *
 * @param previous Previous location
 * @param current New location
 * @returns true if it should be a location-change
 */
function isLocationChange(
  previous: string | null,
  current: string | null
): boolean {
  return (
    previous !== null &&
    previous !== current &&
    (parseLocation(current).visible ||
      (current === 'private' && parseLocation(previous).visible))
  )
}

/**
 * Computes the presence / location state transition (status is not handled here)
 *
 * While `baseline` is true, only state updates (and deletions) are applied and no notification effect is produced.
 * The returned state includes `userId`, so the caller's userId is taken as the first argument.
 *
 * @param userId User ID
 * @param current Current persisted state (undefined for an unknown user)
 * @param displayName User display name
 * @param observation Normalized observation
 * @param baseline Baseline flag fixed at enqueue time
 * @param now Function returning the current time (injectable for tests)
 * @returns Updated state, whether to delete it, and the effects to fire
 */
function reducePresence(
  userId: string,
  current: UserState | undefined,
  displayName: string,
  observation: Exclude<UserObservation, { type: 'profile' }>,
  baseline: boolean,
  now: () => string
): ReduceResult {
  const noEffect: ReducerEffect = { type: 'no-op' }
  const emit = (
    type: SemanticEventType,
    previous: UserState | undefined,
    next: UserState | undefined
  ): ReducerEffect => (baseline ? noEffect : { type, previous, current: next })

  if (observation.type === 'friend-delete') {
    return current === undefined
      ? { nextState: undefined, deleteUser: false, effect: noEffect }
      : {
          nextState: undefined,
          deleteUser: true,
          effect: emit('friend-delete', current, undefined),
        }
  }

  if (observation.type === 'friend-add') {
    if (current !== undefined) {
      return { nextState: current, deleteUser: false, effect: noEffect }
    }
    // Presence is unknown, so record offline (a later online observation will transition it)
    const next: UserState = {
      userId,
      displayName,
      presence: 'offline',
      location: null,
      updatedAt: now(),
    }
    return {
      nextState: next,
      deleteUser: false,
      effect: emit('friend-add', undefined, next),
    }
  }

  // traveling is a transient observation and does not change state
  if (observation.type === 'location' && isTraveling(observation.location)) {
    return { nextState: current, deleteUser: false, effect: noEffect }
  }

  const target = resolveTarget(observation)

  // The first observation for a user without a record is treated as friend-add (online / location-change do not follow)
  if (current === undefined) {
    const next: UserState = {
      userId,
      displayName,
      presence: target.presence,
      location: target.location ?? null,
      updatedAt: now(),
    }
    return {
      nextState: next,
      deleteUser: false,
      effect: emit('friend-add', undefined, next),
    }
  }

  const location =
    target.location === undefined
      ? // When an online observation has no location, keep the confirmed location if already online
        current.presence === 'online'
        ? current.location
        : null
      : target.location

  // Right after going online with an unconfirmed location, treat the first confirmed location as a location-change
  const pending =
    location === null &&
    target.presence === 'online' &&
    (current.firstLocationPending === true || current.presence === 'offline')
  const wasPending = current.firstLocationPending === true

  // With no change, return the same state without updating updatedAt
  if (
    wasPending === pending &&
    current.displayName === displayName &&
    current.presence === target.presence &&
    current.location === location
  ) {
    return { nextState: current, deleteUser: false, effect: noEffect }
  }

  const next: UserState = {
    ...current,
    displayName,
    presence: target.presence,
    location,
    firstLocationPending: pending ? true : undefined,
    updatedAt: now(),
  }

  let effect: ReducerEffect = noEffect
  let followUp: ReducerEffect | undefined
  if (current.presence !== target.presence) {
    effect = emit(
      target.presence === 'online' ? 'online' : 'offline',
      current,
      next
    )
    // If a public Location is confirmed together with going online, location-change also fires
    if (target.presence === 'online' && parseLocation(location).visible) {
      followUp = emit('location-change', current, next)
    }
  } else if (
    target.presence === 'online' &&
    (isLocationChange(current.location, location) ||
      (wasPending && parseLocation(location).visible))
  ) {
    effect = emit('location-change', current, next)
  }

  return { nextState: next, deleteUser: false, effect, followUp }
}

/**
 * Applies a status observation
 *
 * `offline` is not a status users choose themselves, so it is not recorded and the previous value is kept.
 * Unconfirmed (first-seen) fields are only recorded without notifying; a notification fires only when a confirmed field changes.
 *
 * @param base State after applying presence / location (undefined when there is no record)
 * @param profile Observed status and status message
 * @param baseline Whether the baseline is being built
 * @param now Function returning the current time
 * @param profileBaseline Whether the profile comes from a REST snapshot
 * @returns Updated state and the `status-change` effect if something changed
 */
function applyProfile(
  base: UserState | undefined,
  profile: Profile,
  baseline: boolean,
  now: () => string,
  profileBaseline = false
): { state: UserState | undefined; effect?: ReducerEffect } {
  if (base === undefined) return { state: undefined }
  const status =
    profile.status === 'offline' ||
    (profileBaseline && base.status !== undefined)
      ? base.status
      : profile.status
  const statusDescription =
    profileBaseline && base.statusDescription !== undefined
      ? base.statusDescription
      : profile.statusDescription
  if (status === base.status && statusDescription === base.statusDescription) {
    return { state: base }
  }
  const next: UserState = {
    ...base,
    status,
    statusDescription,
    updatedAt: now(),
  }
  // status is not recorded from offline observations, so it may be unconfirmed (message changes are still notified meanwhile)
  const changed =
    (base.status !== undefined && status !== base.status) ||
    (base.statusDescription !== undefined &&
      statusDescription !== base.statusDescription)
  if (baseline || profileBaseline || !changed) return { state: next }
  // Align the previous side with the new value so an unconfirmed status is not treated as a change
  const previous = base.status === undefined ? { ...base, status } : base
  return {
    state: next,
    effect: { type: 'status-change', previous, current: next },
  }
}

/**
 * Pure function computing the state transition shared by WebSocket events and REST snapshots
 *
 * While `baseline` is true, only state updates (and deletions) are applied and no notification effect is produced.
 * The returned state includes `userId`, so the caller's userId is taken as the first argument.
 *
 * @param userId User ID
 * @param current Current persisted state (undefined for an unknown user)
 * @param displayName User display name
 * @param observation Normalized observation
 * @param baseline Baseline flag fixed at enqueue time
 * @param now Function returning the current time (injectable for tests)
 * @returns Updated state, whether to delete it, and the effects to fire (status changes are in `statusEffect`)
 */
export function reduce(
  userId: string,
  current: UserState | undefined,
  displayName: string,
  observation: UserObservation,
  baseline: boolean,
  now: () => string = () => new Date().toISOString()
): ReduceResult {
  // A profile observation does not change presence / location (ignored for users without a record)
  const result: ReduceResult =
    observation.type === 'profile'
      ? { nextState: current, deleteUser: false, effect: { type: 'no-op' } }
      : reducePresence(userId, current, displayName, observation, baseline, now)
  const profile =
    observation.type === 'friend-delete' ? undefined : observation.profile
  if (profile === undefined || result.deleteUser) return result
  const profileBaseline =
    observation.type !== 'friend-delete' && observation.profileBaseline === true
  const applied = applyProfile(
    result.nextState,
    profile,
    baseline,
    now,
    profileBaseline
  )
  return applied.state === result.nextState
    ? result
    : {
        ...result,
        nextState: applied.state,
        effect:
          result.effect.type === 'no-op'
            ? result.effect
            : { ...result.effect, current: applied.state },
        followUp:
          result.followUp && result.followUp.type !== 'no-op'
            ? { ...result.followUp, current: applied.state }
            : result.followUp,
        statusEffect: applied.effect,
      }
}
