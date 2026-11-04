import { parseLocation } from '../state/location'
import type { ReducerEffect } from '../state/user-state-reducer'
import type { UserState } from '../state/user-state'
import type { WorldResolveResult } from '../vrchat/world-resolver'

/** Effect to notify about (excludes no-op) */
export type NotifiableEffect = Exclude<ReducerEffect, { type: 'no-op' }>

/** World resolution results for previous / current */
export interface ContextWorlds {
  previous?: WorldResolveResult
  current?: WorldResolveResult
}

/** Instance owner name resolution results for previous / current (display only) */
export type ContextOwners = ContextWorlds

/**
 * Converts one state into the structure exposed to CEL
 *
 * @param state State to convert
 * @param membership Favorite group membership
 * @param world World resolution result
 * @returns Object for the CEL context
 */
function buildSide(
  state: UserState,
  membership: readonly string[],
  world: WorldResolveResult | undefined
): Record<string, unknown> {
  let location: Record<string, unknown> | null = null
  if (state.location !== null) {
    const parsed = parseLocation(state.location)
    if (parsed.visible) {
      // Omit World values that are not fetched so expressions referencing them fail evaluation.
      const hasName = world?.name !== undefined && world.stale !== true
      const hasCapacity = world?.capacity !== undefined && world.stale !== true
      const worldInfo: Record<string, unknown> = {
        id: parsed.worldId,
        ...(hasName && { name: world.name }),
        ...(hasCapacity && { capacity: world.capacity }),
      }
      location = {
        visible: true,
        world: worldInfo,
        instance: { ...parsed.instance },
      }
    } else {
      location = { visible: false }
    }
  }
  return {
    presence: state.presence,
    status: state.status ?? '',
    statusDescription: state.statusDescription ?? '',
    favoriteGroups: [...membership],
    location,
  }
}

/**
 * Builds the CEL evaluation context from an effect
 *
 * `previous` is null for `friend-add` and `current` is null for `friend-delete`.
 *
 * @param effect Effect to notify about
 * @param membership Favorite group membership at evaluation time
 * @param worlds World resolution results
 * @param now Evaluation time (used for `event.month` etc., interpreted in the local time zone)
 * @returns CEL context
 */
export function buildContext(
  effect: NotifiableEffect,
  membership: readonly string[],
  worlds: ContextWorlds = {},
  now: Date = new Date()
): Record<string, unknown> {
  const subject = effect.current ?? effect.previous
  return {
    // Pass time values as bigint so CEL can do arithmetic and comparisons with int literals
    event: {
      type: effect.type,
      month: BigInt(now.getMonth() + 1),
      day: BigInt(now.getDate()),
      weekday: BigInt(now.getDay()),
      hour: BigInt(now.getHours()),
      minute: BigInt(now.getMinutes()),
    },
    user: {
      id: subject?.userId ?? '',
      displayName: subject?.displayName ?? '',
    },
    previous: effect.previous
      ? buildSide(effect.previous, membership, worlds.previous)
      : null,
    current: effect.current
      ? buildSide(effect.current, membership, worlds.current)
      : null,
  }
}
