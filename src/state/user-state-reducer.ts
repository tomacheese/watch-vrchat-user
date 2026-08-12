import { TRAVELING_LOCATION, type UserState } from './user-state'

/** WebSocket event / REST snapshot を正規化した観測値 */
export type UserObservation =
  | { type: 'online' }
  | { type: 'offline' }
  | { type: 'location'; location: string }

/** reducer が生成する通知用の semantic effect */
export type ReducerEffect =
  | { type: 'online' }
  | {
      type: 'location-change'
      previousLocation: string | null
      currentLocation: string
    }
  | { type: 'offline' }
  | { type: 'no-op' }

/** reduce の結果 */
export interface ReduceResult {
  /** 更新後の state。判断材料が不足し何も記録できない場合は undefined */
  nextState: UserState | undefined
  /** 発火すべき通知 effect */
  effect: ReducerEffect
}

/**
 * WebSocket event / REST snapshot 共通の状態遷移を計算する純粋関数
 *
 * @param current 現在の永続 state（未知のユーザーは undefined）
 * @param displayName ユーザーの表示名
 * @param observation 正規化済みの観測値
 * @param now 現在時刻を返す関数（テスト用に注入可能）
 * @returns 更新後の state と発火すべき effect
 */
export function reduce(
  current: UserState | undefined,
  displayName: string,
  observation: UserObservation,
  now: () => string = () => new Date().toISOString()
): ReduceResult {
  if (
    observation.type === 'location' &&
    observation.location === TRAVELING_LOCATION
  ) {
    // traveling は transient observation であり、persisted location も lastConfirmedLocation も変更しない
    return { nextState: current, effect: { type: 'no-op' } }
  }

  if (observation.type === 'location') {
    return reduceLocation(current, displayName, observation.location, now)
  }

  if (observation.type === 'online') {
    return reduceOnline(current, displayName, now)
  }

  return reduceOffline(current, displayName, now)
}

/**
 * concrete location（private を含む）の観測値を処理する
 *
 * @param current 現在の state
 * @param displayName 表示名
 * @param location 確定した Location
 * @param now 現在時刻を返す関数
 * @returns reduce 結果
 */
function reduceLocation(
  current: UserState | undefined,
  displayName: string,
  location: string,
  now: () => string
): ReduceResult {
  // record 不在、または offline からの遷移は baseline のみで通知しない
  // (8.6 unknown baseline / friend-online 欠落時の online 推定は effect のみ 'online' として区別する)
  if (current === undefined) {
    return {
      nextState: {
        userId: '',
        displayName,
        presence: 'online',
        location,
        updatedAt: now(),
      },
      effect: { type: 'no-op' },
    }
  }

  const nextState: UserState = {
    ...current,
    displayName,
    presence: 'online',
    location,
    updatedAt: now(),
  }

  if (current.presence === 'offline') {
    return { nextState, effect: { type: 'online' } }
  }

  if (current.location === null) {
    return { nextState, effect: { type: 'no-op' } }
  }

  if (current.location === location) {
    return { nextState, effect: { type: 'no-op' } }
  }

  return {
    nextState,
    effect: {
      type: 'location-change',
      previousLocation: current.location,
      currentLocation: location,
    },
  }
}

/**
 * online 観測値を処理する
 *
 * @param current 現在の state
 * @param displayName 表示名
 * @param now 現在時刻を返す関数
 * @returns reduce 結果
 */
function reduceOnline(
  current: UserState | undefined,
  displayName: string,
  now: () => string
): ReduceResult {
  if (current === undefined) {
    // record 不在ユーザーへの最初の observation は baseline のみで通知しない（8.6 unknown baseline）
    return {
      nextState: {
        userId: '',
        displayName,
        presence: 'online',
        location: null,
        updatedAt: now(),
      },
      effect: { type: 'no-op' },
    }
  }

  if (current.presence === 'online') {
    return { nextState: current, effect: { type: 'no-op' } }
  }

  return {
    nextState: {
      ...current,
      displayName,
      presence: 'online',
      location: null,
      updatedAt: now(),
    },
    effect: { type: 'online' },
  }
}

/**
 * offline 観測値を処理する
 *
 * @param current 現在の state
 * @param displayName 表示名
 * @param now 現在時刻を返す関数
 * @returns reduce 結果
 */
function reduceOffline(
  current: UserState | undefined,
  displayName: string,
  now: () => string
): ReduceResult {
  if (current === undefined || current.presence === 'offline') {
    return {
      nextState: {
        userId: current?.userId ?? '',
        displayName,
        presence: 'offline',
        location: null,
        updatedAt: now(),
      },
      effect: { type: 'no-op' },
    }
  }

  return {
    nextState: {
      ...current,
      displayName,
      presence: 'offline',
      location: null,
      updatedAt: now(),
    },
    effect: { type: 'offline' },
  }
}
