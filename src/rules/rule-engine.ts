import { Logger } from '@book000/node-utils'
import { Environment } from '@marcbachmann/cel-js'
import type { CompiledRule } from '../config/config-snapshot'
import type { RawRule } from '../config/config-file'

const logger = Logger.configure('RuleEngine')

/** Interval between warnings (ms) */
const WARN_INTERVAL_MS = 60 * 1000
/** Window of recent errors kept for health (ms) */
const RECENT_WINDOW_MS = 60 * 60 * 1000

/** Rule evaluation error */
export interface RuleError {
  rule: string
  kind: string
  message: string
}

/** Evaluation result */
export interface EvaluationResult {
  /** Names of matched rules (in configuration order) */
  matched: string[]
  /** Evaluation errors */
  errors: RuleError[]
}

/** Rule error summary for health */
export interface RuleErrorSummary {
  rule: string
  count: number
  lastAt: string
  lastError: string
}

/** Summary entry per error kind */
interface ErrorEntry {
  occurrences: number[]
  lastAtMs: number
  lastError: string
  lastWarnMs: number
}

/**
 * Aggregates rule evaluation errors and throttles warnings
 */
export class RuleErrorLog {
  private readonly entries = new Map<string, ErrorEntry>()

  /**
   * Records an error. Warnings are limited to one per interval for each (rule name, kind)
   *
   * @param ruleName Rule name
   * @param kind Error kind
   * @param message Error message
   * @param now Current time (ms)
   */
  record(ruleName: string, kind: string, message: string, now: number): void {
    const key = JSON.stringify([ruleName, kind])
    const entry = this.entries.get(key)
    if (entry === undefined) {
      this.entries.set(key, {
        occurrences: [now],
        lastAtMs: now,
        lastError: message,
        lastWarnMs: now,
      })
      this.warn(ruleName, kind, message)
      return
    }
    entry.occurrences = entry.occurrences.filter(
      (at) => now - at <= RECENT_WINDOW_MS
    )
    entry.occurrences.push(now)
    entry.lastAtMs = now
    entry.lastError = message
    if (now - entry.lastWarnMs < WARN_INTERVAL_MS) return
    entry.lastWarnMs = now
    this.warn(ruleName, kind, message)
  }

  /**
   * Summarizes errors within the window per rule name
   *
   * @param now Current time (ms)
   * @returns Summary
   */
  getRecent(now: number): RuleErrorSummary[] {
    const byRule = new Map<string, RuleErrorSummary & { atMs: number }>()
    for (const [key, entry] of this.entries) {
      entry.occurrences = entry.occurrences.filter(
        (at) => now - at <= RECENT_WINDOW_MS
      )
      if (entry.occurrences.length === 0) {
        this.entries.delete(key)
        continue
      }
      const [rule] = JSON.parse(key) as [string, string]
      const existing = byRule.get(rule)
      if (existing === undefined) {
        byRule.set(rule, {
          rule,
          count: entry.occurrences.length,
          lastAt: new Date(entry.lastAtMs).toISOString(),
          lastError: entry.lastError,
          atMs: entry.lastAtMs,
        })
      } else {
        existing.count += entry.occurrences.length
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
   * Emits a rate-limited warning
   *
   * @param ruleName Rule name
   * @param kind Error kind
   * @param message Error message
   */
  private warn(ruleName: string, kind: string, message: string): void {
    logger.warn(`Rule "${ruleName}" evaluation failed (${kind}): ${message}`)
  }
}

/** Structural limits for rule expressions */
export const CEL_LIMITS = {
  maxAstNodes: 500,
  maxDepth: 32,
  maxListElements: 100,
  maxMapEntries: 100,
  maxCallArguments: 8,
}

// previous / current can be null, so declare them as dyn (schema typing cannot compare with null)
const env = new Environment({ limits: CEL_LIMITS })
  .registerVariable('event', 'map')
  .registerVariable('user', 'map')
  .registerVariable('previous', 'dyn')
  .registerVariable('current', 'dyn')

/**
 * Extracts a message from an error value
 *
 * @param error Caught value
 * @returns Message
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Compiles raw rules. Throws a configuration error if any rule is invalid
 *
 * Disabled rules are also validated for syntax and types.
 *
 * @param raw Validated raw rules
 * @returns Compiled rules (in configuration order)
 * @throws If an expression is invalid (English message including the rule name)
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
      when: rule.when,
      enabled: rule.enabled,
      destinations: [...rule.destinations],
      program: (context: Record<string, unknown>): unknown => program(context),
    }
  })
}

/**
 * Evaluates enabled rules and returns matched rule names and errors
 *
 * An exception or non-boolean result in one rule makes only that rule false and does not stop the others.
 *
 * @param rules Compiled rules
 * @param context CEL context
 * @returns Evaluation result
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
