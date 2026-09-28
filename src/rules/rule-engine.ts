import { Logger } from '@book000/node-utils'
import { Environment } from '@marcbachmann/cel-js'
import type { CompiledRule } from '../config/config-snapshot'
import type { RawRule } from '../config/config-file'

const logger = Logger.configure('RuleEngine')

/** warning を出す間隔（ミリ秒） */
const WARN_INTERVAL_MS = 60 * 1000
/** health 用に保持する直近エラーの窓（ミリ秒） */
const RECENT_WINDOW_MS = 60 * 60 * 1000

/** ルール評価エラー */
export interface RuleError {
  rule: string
  kind: string
  message: string
}

/** 評価結果 */
export interface EvaluationResult {
  /** 一致したルール名（設定順） */
  matched: string[]
  /** 評価エラー */
  errors: RuleError[]
}

/** health 用のルールエラー集計 */
export interface RuleErrorSummary {
  rule: string
  count: number
  lastAt: string
  lastError: string
}

/** エラー種別ごとの集計エントリ */
interface ErrorEntry {
  count: number
  lastAtMs: number
  lastError: string
  lastWarnMs: number
}

/**
 * ルール評価エラーの集計と warning 抑制を行う
 */
export class RuleErrorLog {
  private readonly entries = new Map<string, ErrorEntry>()

  /**
   * エラーを記録する。warning は (ルール名, 種別) ごとに一定間隔に 1 回までに抑制する
   *
   * @param ruleName ルール名
   * @param kind エラー種別
   * @param message エラーメッセージ
   * @param now 現在時刻（ミリ秒）
   */
  record(ruleName: string, kind: string, message: string, now: number): void {
    const key = JSON.stringify([ruleName, kind])
    const entry = this.entries.get(key)
    if (entry === undefined) {
      this.entries.set(key, {
        count: 1,
        lastAtMs: now,
        lastError: message,
        lastWarnMs: now,
      })
      this.warn(ruleName, kind, message)
      return
    }
    entry.count++
    entry.lastAtMs = now
    entry.lastError = message
    if (now - entry.lastWarnMs < WARN_INTERVAL_MS) return
    entry.lastWarnMs = now
    this.warn(ruleName, kind, message)
  }

  /**
   * 集計窓内のエラーをルール名ごとに集計して返す
   *
   * @param now 現在時刻（ミリ秒）
   * @returns 集計結果
   */
  getRecent(now: number): RuleErrorSummary[] {
    const byRule = new Map<string, RuleErrorSummary & { atMs: number }>()
    for (const [key, entry] of this.entries) {
      if (now - entry.lastAtMs > RECENT_WINDOW_MS) continue
      const [rule] = JSON.parse(key) as [string, string]
      const existing = byRule.get(rule)
      if (existing === undefined) {
        byRule.set(rule, {
          rule,
          count: entry.count,
          lastAt: new Date(entry.lastAtMs).toISOString(),
          lastError: entry.lastError,
          atMs: entry.lastAtMs,
        })
      } else {
        existing.count += entry.count
        if (entry.lastAtMs >= existing.atMs) {
          existing.atMs = entry.lastAtMs
          existing.lastAt = new Date(entry.lastAtMs).toISOString()
          existing.lastError = entry.lastError
        }
      }
    }
    return byRule
      .values()
      .map(({ rule, count, lastAt, lastError }) => ({
        rule,
        count,
        lastAt,
        lastError,
      }))
      .toArray()
  }

  /**
   * rate-limit 済みの warning を出す
   *
   * @param ruleName ルール名
   * @param kind エラー種別
   * @param message エラーメッセージ
   */
  private warn(ruleName: string, kind: string, message: string): void {
    logger.warn(`Rule "${ruleName}" evaluation failed (${kind}): ${message}`)
  }
}

/** ルール式の構造上限 */
const CEL_LIMITS = {
  maxAstNodes: 500,
  maxDepth: 32,
  maxListElements: 100,
  maxMapEntries: 100,
  maxCallArguments: 8,
}

// previous / current は null を取りうるため dyn で宣言する（schema 型付けは null 比較不可）
const env = new Environment({ limits: CEL_LIMITS })
  .registerVariable('event', 'map')
  .registerVariable('user', 'map')
  .registerVariable('previous', 'dyn')
  .registerVariable('current', 'dyn')

/**
 * エラー値からメッセージを取り出す
 *
 * @param error 捕捉した値
 * @returns メッセージ
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 生ルールを compile する。1 つでも不正なら設定エラーとして throw する
 *
 * disabled ルールも構文・型の検証は行う。
 *
 * @param raw 検証済みの生ルール
 * @returns compile 済みルール（設定順）
 * @throws 式が不正な場合（ルール名を含む英語メッセージ）
 */
export function compileRules(raw: RawRule[]): CompiledRule[] {
  return raw.map((rule) => {
    const checked = env.check(rule.when)
    if (!checked.valid) {
      throw new Error(
        `Invalid CEL expression in rule "${rule.name}": ${messageOf(checked.error)}`
      )
    }
    if (checked.type !== 'bool' && checked.type !== 'dyn') {
      throw new Error(
        `Rule "${rule.name}" must evaluate to bool, but got ${String(checked.type)}`
      )
    }
    const program = env.parse(rule.when)
    return {
      name: rule.name,
      enabled: rule.enabled,
      destinations: [...rule.destinations],
      program: (context: Record<string, unknown>): unknown => program(context),
    }
  })
}

/**
 * 有効なルールを評価し、一致したルール名とエラーを返す
 *
 * 1 ルールの例外や非 boolean の結果は当該ルールのみ false とし、他ルールを止めない。
 *
 * @param rules compile 済みルール
 * @param context CEL コンテキスト
 * @returns 評価結果
 */
export function evaluateRules(
  rules: readonly CompiledRule[],
  context: Record<string, unknown>
): EvaluationResult {
  const matched: string[] = []
  const errors: RuleError[] = []
  for (const rule of rules) {
    if (!rule.enabled) continue
    try {
      const result = rule.program(context)
      if (typeof result === 'boolean') {
        if (result) matched.push(rule.name)
      } else {
        errors.push({
          rule: rule.name,
          kind: 'non-boolean',
          message: 'Expression did not evaluate to a boolean',
        })
      }
    } catch (error) {
      errors.push({
        rule: rule.name,
        kind: 'evaluation',
        message: messageOf(error),
      })
    }
  }
  return { matched, errors }
}
