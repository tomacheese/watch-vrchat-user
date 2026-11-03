import { Logger, type DiscordEmbed } from '@book000/node-utils'
import type { DestinationConfig } from '../config/config-file'
import type { ConfigSnapshot } from '../config/config-snapshot'
import { parseLocation } from '../state/location'
import type { ReducerEffect } from '../state/user-state-reducer'
import type { UserState } from '../state/user-state'
import { buildContext } from '../rules/rule-context'
import { evaluateRules, type EvaluationResult } from '../rules/rule-engine'
import type { WorldResolveResult } from '../vrchat/world-resolver'
import { toError } from '../logger-utils'
import { buildEmbed } from './embed-builder'

const logger = Logger.configure('DISPATCHER')

/** Components the dispatcher depends on (structural types that tests can replace) */
export interface NotificationDispatcherDeps {
  worldResolver: { resolve(worldId: string): Promise<WorldResolveResult> }
  ownerResolver: { resolve(ownerId: string): Promise<WorldResolveResult> }
  favorites: { getGroups(userId: string): string[] }
  notifier: {
    send(
      destinationName: string,
      url: string,
      embed: DiscordEmbed
    ): Promise<void>
  }
  evaluateRules?: (
    rules: ConfigSnapshot['rules'],
    context: Record<string, unknown>
  ) => Promise<EvaluationResult>
  errorLog: {
    record(ruleName: string, kind: string, message: string, now: number): void
  }
}

/** Notification content that can be persisted before sending */
export interface PreparedNotification {
  name: string
  url: string
  embed: DiscordEmbed
}

/** Evaluates rules for an effect and notifies the matching destinations */
export class NotificationDispatcher {
  /**
   * Initializes the NotificationDispatcher
   *
   * @param deps Dependencies
   */
  constructor(private readonly deps: NotificationDispatcherDeps) {}

  /**
   * Evaluates a state change (effect) and notifies
   *
   * @param userId User ID used to look up Favorite groups
   * @param _displayName Display name (unused; the effect carries its own)
   * @param effect Reducer effect
   * @param snapshot Config snapshot at acceptance time
   */
  async handleEffect(
    userId: string,
    _displayName: string,
    effect: ReducerEffect,
    snapshot: ConfigSnapshot
  ): Promise<void> {
    const notifications = await this.prepareEffect(userId, effect, snapshot)
    const results = await Promise.allSettled(
      notifications.map(async ({ name, url, embed }) => {
        await this.deps.notifier.send(name, url, embed)
      })
    )
    for (const [index, result] of results.entries()) {
      if (result.status !== 'rejected') continue
      const { name, url } = notifications[index]
      const message = toError(result.reason)
        .message.split(url)
        .join('[redacted]')
      logger.error(`Failed to notify destination "${name}": ${message}`)
    }
  }

  /** Evaluates the effect and builds the delivery content. Sending happens after the outbox is saved */
  async prepareEffect(
    userId: string,
    effect: ReducerEffect,
    snapshot: ConfigSnapshot,
    evaluatedAt: Date = new Date()
  ): Promise<PreparedNotification[]> {
    if (effect.type === 'no-op') return []
    if (snapshot.rules.every((rule) => !rule.enabled)) return []

    const [previous, current] = await Promise.all([
      this.resolveWorld(effect.previous),
      this.resolveWorld(effect.current),
    ])
    const worlds = { previous, current }
    // Membership is not removed on friend-delete either (it is replaced by the next Favorites refresh)
    const membership = this.deps.favorites.getGroups(userId)
    const context = buildContext(effect, membership, worlds, evaluatedAt)
    const { matched, errors } = this.deps.evaluateRules
      ? await this.deps.evaluateRules(snapshot.rules, context)
      : evaluateRules(snapshot.rules, context)
    for (const error of errors) {
      this.deps.errorLog.record(
        error.rule,
        error.kind,
        error.message,
        Date.now()
      )
    }
    if (matched.length === 0) {
      logger.info(`No rule matched: event=${effect.type} user=${userId}`)
      return []
    }

    // The owner is display-only, so it is resolved only when a rule matched
    const [previousOwner, currentOwner] = await Promise.all([
      this.resolveOwner(effect.previous),
      this.resolveOwner(effect.current),
    ])
    const owners = { previous: previousOwner, current: currentOwner }

    // Group matched rule names per destination, in config order
    const byDestination = new Map<string, string[]>()
    for (const rule of snapshot.rules) {
      if (!matched.includes(rule.name)) continue
      for (const destination of rule.destinations) {
        byDestination.set(destination, [
          ...(byDestination.get(destination) ?? []),
          rule.name,
        ])
      }
    }
    logger.info(
      `Matched rules: event=${effect.type} user=${userId} ${matched.join(', ')} -> destinations: ${byDestination.keys().toArray().join(', ')}`
    )

    return [...byDestination].flatMap(([name, ruleNames]) => {
      const destination = snapshot.destinations[name] as
        DestinationConfig | undefined
      if (!destination) {
        logger.warn(`Destination "${name}" is not defined, skipping`)
        return []
      }
      return {
        name,
        url: destination.url,
        embed: buildEmbed(
          effect,
          worlds,
          ruleNames,
          evaluatedAt.toISOString(),
          owners
        ),
      }
    })
  }

  /** Resolves the world of a visible Location. A failure is treated as "no name" */
  private async resolveWorld(
    state: UserState | undefined
  ): Promise<WorldResolveResult | undefined> {
    const parsed = parseLocation(state?.location ?? null)
    if (!parsed.visible) return undefined
    try {
      return await this.deps.worldResolver.resolve(parsed.worldId)
    } catch (error) {
      logger.warn(
        `Failed to resolve world ${parsed.worldId}: ${toError(error).message}`
      )
      return { stale: true }
    }
  }

  /** Resolves the instance owner name of a visible Location. undefined when there is no owner */
  private async resolveOwner(
    state: UserState | undefined
  ): Promise<WorldResolveResult | undefined> {
    const parsed = parseLocation(state?.location ?? null)
    if (!parsed.visible || parsed.instance.ownerId === '') return undefined
    try {
      return await this.deps.ownerResolver.resolve(parsed.instance.ownerId)
    } catch (error) {
      logger.warn(
        `Failed to resolve owner ${parsed.instance.ownerId}: ${toError(error).message}`
      )
      return { stale: true }
    }
  }
}
