import { parseLocation } from '../state/location'
import type { ReducerEffect } from '../state/user-state-reducer'
import type { UserState } from '../state/user-state'
import type { WorldResolveResult } from '../vrchat/world-resolver'

/** 通知対象の effect（no-op を除く） */
export type NotifiableEffect = Exclude<ReducerEffect, { type: 'no-op' }>

/** previous / current それぞれの World 解決結果 */
export interface ContextWorlds {
  previous?: WorldResolveResult
  current?: WorldResolveResult
}

/** previous / current それぞれのインスタンスオーナー名の解決結果（通知表示用） */
export type ContextOwners = ContextWorlds

/**
 * 1 つの state を CEL 公開用の構造へ変換する
 *
 * @param state 変換対象の state
 * @param membership Favorite group の所属
 * @param world World 解決結果
 * @returns CEL コンテキスト用オブジェクト
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
      // 未取得の World 値は含めず、参照する式を評価エラーにする。
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
 * effect から CEL の評価コンテキストを組み立てる
 *
 * `friend-add` は previous が null、`friend-delete` は current が null になる。
 *
 * @param effect 通知対象の effect
 * @param membership 評価時点の Favorite group 所属
 * @param worlds World 解決結果
 * @param now 評価時刻（`event.month` などの算出に使う。ローカルタイムゾーンで解釈する）
 * @returns CEL コンテキスト
 */
export function buildContext(
  effect: NotifiableEffect,
  membership: readonly string[],
  worlds: ContextWorlds = {},
  now: Date = new Date()
): Record<string, unknown> {
  const subject = effect.current ?? effect.previous
  return {
    // 時刻は CEL の int リテラルと算術・比較できるよう bigint で渡す
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
