import type { DestinationConfig } from './config-file'

/** compile 済みの CEL 式。コンテキストを渡して評価する */
export type CompiledProgram = (context: Record<string, unknown>) => unknown

/** compile 済みのルール */
export interface CompiledRule {
  /** ルール名（設定内で一意） */
  name: string
  /** 有効かどうか */
  enabled: boolean
  /** 通知先 destination 名 */
  destinations: string[]
  /** Worker と永続 outbox で再構築する元の CEL 式 */
  when?: string
  /** compile 済みの条件式 */
  program: CompiledProgram
}

/**
 * ある時点で有効な設定の不変スナップショット
 *
 * イベントは受理（enqueue）時点のスナップショットで最後まで評価される。
 */
export interface ConfigSnapshot {
  /** destination 名をキーとした通知先定義 */
  readonly destinations: Readonly<Record<string, DestinationConfig>>
  /** 設定ファイルの並び順を保持した compile 済みルール */
  readonly rules: readonly CompiledRule[]
  /** 読み込み日時（ISO 8601 形式） */
  readonly loadedAt: string
}
