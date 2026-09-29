import { Logger, type DiscordEmbed } from '@book000/node-utils'
import type { DestinationConfig } from '../config/config-file'
import type { ConfigSnapshot } from '../config/config-snapshot'
import { parseLocation } from '../state/location'
import type { ReducerEffect } from '../state/user-state-reducer'
import type { UserState } from '../state/user-state'
import { buildContext } from '../rules/rule-context'
import { evaluateRules } from '../rules/rule-engine'
import type { WorldResolveResult } from '../vrchat/world-resolver'
import { toError } from '../logger-utils'
import { buildEmbed } from './embed-builder'

const logger = Logger.configure('DISPATCHER')

/** Dispatcher が依存するコンポーネント（テストで差し替え可能な構造的型） */
export interface NotificationDispatcherDeps {
  worldResolver: { resolve(worldId: string): Promise<WorldResolveResult> }
  favorites: { getGroups(userId: string): string[] }
  notifier: {
    send(
      destinationName: string,
      url: string,
      embed: DiscordEmbed
    ): Promise<void>
  }
  errorLog: {
    record(ruleName: string, kind: string, message: string, now: number): void
  }
}

/**
 * effect をルール評価し、一致した destination へ通知するクラス
 */
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
    if (effect.type === 'no-op') return

    const [previous, current] = await Promise.all([
      this.resolveWorld(effect.previous),
      this.resolveWorld(effect.current),
    ])
    const worlds = { previous, current }
    // friend-delete でも membership は除去しない（次回の Favorites 更新で置き換わる）
    const membership = this.deps.favorites.getGroups(userId)
    const { matched, errors } = evaluateRules(
      snapshot.rules,
      buildContext(effect, membership, worlds)
    )
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
      return
    }

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

    const entries = [...byDestination]
    const results = await Promise.allSettled(
      entries.map(async ([name, ruleNames]) => {
        const destination = snapshot.destinations[name] as
          DestinationConfig | undefined
        if (destination === undefined) {
          logger.warn(`Destination "${name}" is not defined, skipping`)
          return
        }
        await this.deps.notifier.send(
          name,
          destination.url,
          buildEmbed(effect, worlds, ruleNames)
        )
      })
    )
    for (const [index, result] of results.entries()) {
      if (result.status !== 'rejected') continue
      const [name] = entries[index]
      // URL がエラー文言に含まれていても出さない
      const url = snapshot.destinations[name].url
      const message = toError(result.reason)
        .message.split(url)
        .join('[redacted]')
      logger.error(`Failed to notify destination "${name}": ${message}`)
    }
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
}
