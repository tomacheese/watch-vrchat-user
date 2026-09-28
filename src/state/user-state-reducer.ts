import { isTraveling, parseLocation } from './location'
import type { Presence, UserState } from './user-state'

/** WebSocket event / REST snapshot を正規化した観測値 */
export type UserObservation =
  | { type: 'online'; location?: string }
  | { type: 'offline' }
  | { type: 'location'; location: string }
  | { type: 'friend-add' }
  | { type: 'friend-delete' }

/** 通知対象の semantic event 種別 */
export type SemanticEventType =
  'online' | 'offline' | 'location-change' | 'friend-add' | 'friend-delete'

/**
 * reducer が生成する通知用の semantic effect
 *
 * `friend-add` は previous が undefined、`friend-delete` は current が undefined になる。
 */
export type ReducerEffect =
  | { type: 'no-op' }
  | {
      type: SemanticEventType
      previous: UserState | undefined
      current: UserState | undefined
    }

/** reduce の結果 */
export interface ReduceResult {
  /** 更新後の state。判断材料が不足し何も記録できない場合、または削除対象の場合は undefined */
  nextState: UserState | undefined
  /** state から record を削除すべきか（`friend-delete` で record が既存の場合） */
  deleteUser: boolean
  /** 発火すべき通知 effect */
  effect: ReducerEffect
}

/**
 * 観測値から求めた、記録すべき presence と location
 */
interface Target {
  presence: Presence
  /** undefined は「現在の location を維持する」を表す */
  location: string | null | undefined
}

/**
 * 観測値から更新後の presence / location を求める
 *
 * @param observation friend-add / friend-delete 以外の観測値
 * @returns 更新後の presence / location
 */
function resolveTarget(
  observation: Exclude<
    UserObservation,
    { type: 'friend-add' } | { type: 'friend-delete' }
  >
): Target {
  // online の location は任意。traveling は確定値ではないため無視する
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
 * 2 つの location がどちらも可視で raw 値が異なるかを判定する
 *
 * @param previous 前回の location
 * @param current 今回の location
 * @returns location-change とすべき場合は true
 */
function isVisibleChange(
  previous: string | null,
  current: string | null
): boolean {
  return (
    previous !== current &&
    parseLocation(previous).visible &&
    parseLocation(current).visible
  )
}

/**
 * WebSocket event / REST snapshot 共通の状態遷移を計算する純粋関数
 *
 * `baseline` が true の間は、state の更新（および削除）だけを行い、通知 effect は生成しない。
 * 戻り値の state に `userId` を含めるため、呼び出し元の userId を第 1 引数で受け取る。
 *
 * @param userId ユーザー ID
 * @param current 現在の永続 state（未知のユーザーは undefined）
 * @param displayName ユーザーの表示名
 * @param observation 正規化済みの観測値
 * @param baseline enqueue 時に確定した baseline フラグ
 * @param now 現在時刻を返す関数（テスト用に注入可能）
 * @returns 更新後の state・削除要否・発火すべき effect
 */
export function reduce(
  userId: string,
  current: UserState | undefined,
  displayName: string,
  observation: UserObservation,
  baseline: boolean,
  now: () => string = () => new Date().toISOString()
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
    // 在席状態は不明なため offline で記録する（以降の online 観測で遷移する）
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

  // traveling は transient observation であり state を変更しない
  if (observation.type === 'location' && isTraveling(observation.location)) {
    return { nextState: current, deleteUser: false, effect: noEffect }
  }

  const target = resolveTarget(observation)

  // record 不在ユーザーへの最初の観測は friend-add として扱う（online / location-change は続けて生成しない）
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
      ? // online 観測に location が無い場合、online 中なら確定済みの location を維持する
        current.presence === 'online'
        ? current.location
        : null
      : target.location

  // online 遷移直後で location が未確定なら、最初の確定 location を location-change として扱う
  const pending =
    location === null &&
    target.presence === 'online' &&
    (current.firstLocationPending === true || current.presence === 'offline')
  const wasPending = current.firstLocationPending === true

  // 変化が無ければ updatedAt も更新せず、同一 state を返す
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
  if (current.presence !== target.presence) {
    effect = emit(
      target.presence === 'online' ? 'online' : 'offline',
      current,
      next
    )
  } else if (
    target.presence === 'online' &&
    (isVisibleChange(current.location, location) ||
      (wasPending && parseLocation(location).visible))
  ) {
    effect = emit('location-change', current, next)
  }

  return { nextState: next, deleteUser: false, effect }
}
