import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import type { CompiledRule } from '../config/config-snapshot'
import {
  CEL_LIMITS,
  type EvaluationResult,
  type RuleError,
} from './rule-engine'

/** Worker 起動と 1 ルールの実行に対する期限 */
export interface RuleEvaluatorOptions {
  timeoutMs?: number
  startupTimeoutMs?: number
}

// 設定由来の式は実行コードへ挿入せず、structured clone で送る。
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { Environment } = await import(workerData.modulePath);
  const env = new Environment({ limits: workerData.limits })
    .registerVariable('event', 'map').registerVariable('user', 'map')
    .registerVariable('previous', 'dyn').registerVariable('current', 'dyn');
  const cache = new Map();
  parentPort.on('message', ({ expression, context }) => {
    try {
      let program = cache.get(expression);
      if (!program) {
        if (cache.size >= 256) cache.clear();
        program = env.parse(expression);
        cache.set(expression, program);
      }
      const result = program(context);
      parentPort.postMessage(typeof result === 'boolean'
        ? { matched: result }
        : { kind: 'non-boolean', message: 'Expression did not evaluate to a boolean' });
    } catch (error) {
      parentPort.postMessage({ kind: 'evaluation', message: error instanceof Error ? error.message : String(error) });
    }
  });
  parentPort.postMessage({ ready: true });
})().catch(() => process.exit(1));
`

/** CEL を期限付き Worker で評価し、問題のあるルールだけを不一致にする */
export class RuleEvaluator {
  private readonly timeoutMs: number
  private readonly startupTimeoutMs: number
  private worker: Worker | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private stopped = false

  /** 評価期限を設定する */
  constructor(options: RuleEvaluatorOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 100
    this.startupTimeoutMs = options.startupTimeoutMs ?? 2000
  }

  /** 複数イベントの評価を直列化し、同じ Worker の応答を混同しない */
  async evaluate(
    rules: readonly CompiledRule[],
    context: Record<string, unknown>
  ): Promise<EvaluationResult> {
    const operation = this.queue
      .catch(() => undefined)
      .then(() => this.evaluateSerial(rules, context))
    this.queue = operation
    return operation
  }

  /** 評価中の Worker を停止する */
  async stop(): Promise<void> {
    this.stopped = true
    await this.discardWorker()
  }

  /** 各ルールの期限切れ後は Worker を捨て、後続ルールを別 Worker で続ける */
  private async evaluateSerial(
    rules: readonly CompiledRule[],
    context: Record<string, unknown>
  ): Promise<EvaluationResult> {
    const matched: string[] = []
    const errors: RuleError[] = []
    for (const rule of rules) {
      if (!rule.enabled) continue
      if (rule.when === undefined) {
        errors.push({
          rule: rule.name,
          kind: 'evaluation',
          message: 'Rule expression is unavailable',
        })
        continue
      }
      try {
        const worker = await this.getWorker()
        const result = await this.receive(worker, this.timeoutMs, () => {
          worker.postMessage({ expression: rule.when, context })
        })
        if (result.matched === true) matched.push(rule.name)
        else if (result.kind)
          errors.push({
            rule: rule.name,
            kind: result.kind,
            message: result.message ?? 'Rule evaluation failed',
          })
      } catch (error) {
        await this.discardWorker()
        errors.push({
          rule: rule.name,
          kind: 'evaluation',
          message:
            error instanceof Error ? error.message : 'Rule worker failed',
        })
      }
    }
    return { matched, errors }
  }

  /** Worker の初期化はルール実行とは別の期限で待つ */
  private async getWorker(): Promise<Worker> {
    if (this.stopped) throw new Error('Rule evaluator stopped')
    if (this.worker) return this.worker
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        // CommonJS と ts-jest の両方でこのモジュールから依存を解決する。
        // eslint-disable-next-line unicorn/prefer-module
        modulePath: createRequire(__filename).resolve('@marcbachmann/cel-js'),
        limits: CEL_LIMITS,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
      },
    })
    this.worker = worker
    // 待機中以外は Worker がプロセス終了を妨げない。
    worker.unref()
    const result = await this.receive(worker, this.startupTimeoutMs)
    if (!result.ready) throw new Error('Rule worker failed to initialize')
    return worker
  }

  /** リスナーを確実に解除して 1 回の Worker 応答を待つ */
  private async receive(
    worker: Worker,
    timeoutMs: number,
    start?: () => void
  ): Promise<{
    ready?: boolean
    matched?: boolean
    kind?: string
    message?: string
  }> {
    worker.ref()
    try {
      const { promise, resolve, reject } = Promise.withResolvers<{
        ready?: boolean
        matched?: boolean
        kind?: string
        message?: string
      }>()
      const onError = () => {
        reject(new Error('Rule worker failed'))
      }
      const onExit = () => {
        reject(new Error('Rule worker exited'))
      }
      const timer = setTimeout(() => {
        reject(new Error(`Rule evaluation timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      worker.once('message', resolve)
      worker.once('error', onError)
      worker.once('exit', onExit)
      try {
        start?.()
        return await promise
      } finally {
        clearTimeout(timer)
        worker.off('message', resolve)
        worker.off('error', onError)
        worker.off('exit', onExit)
      }
    } finally {
      worker.unref()
    }
  }

  /** 期限切れの処理を OS スレッドごと終了する */
  private async discardWorker(): Promise<void> {
    const worker = this.worker
    this.worker = undefined
    if (worker) await worker.terminate()
  }
}
