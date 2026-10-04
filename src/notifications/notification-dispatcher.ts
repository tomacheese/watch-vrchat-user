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

/** Dispatcher が依存するコンポーネント（テストで差し替え可能な構造的型） */
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

/**
 * effect をルール評価し、一致した destination へ通知するクラス
 */
/** 送信前に永続化できる通知内容 */
export interface PreparedNotification {
  name: string
  url: string
  embed: DiscordEmbed
}

export class NotificationDispatcher {
  /**
   * NotificationDispatcher を初期化する
   *
   * @param deps 依存コンポーネント
   */
  constructor(private readonly deps: NotificationDispatcherDeps) {}

  /**
   * state の変化（effect）を評価して通知する
   *
   * @param userId Favorite group の照会に使うユーザー ID
   * @param _displayName 表示名（effect 側の値を使うため未使用）
   * @param effect reducer の effect
   * @param snapshot 受理時点の設定スナップショット
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

  /** effect を評価し、配信内容を作る。送信は outbox の保存後に行う */
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
    // friend-delete でも membership は除去しない（次回の Favorites 更新で置き換わる）
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

    // owner は表示専用のため、一致したときだけ解決する
    const [previousOwner, currentOwner] = await Promise.all([
      this.resolveOwner(effect.previous),
      this.resolveOwner(effect.current),
    ])
    const owners = { previous: previousOwner, current: currentOwner }

    // destination ごとに一致ルール名を設定順でまとめる
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
      return [
        {
          name,
          url: destination.url,
          embed: buildEmbed(
            effect,
            worlds,
            ruleNames,
            evaluatedAt.toISOString(),
            owners
          ),
        },
      ]
    })
  }

  /** 可視な Location のワールドを解決する。失敗は「名前なし」として扱う */
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

  /** 可視な Location のインスタンスオーナー名を解決する。オーナーがいない場合は undefined */
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
