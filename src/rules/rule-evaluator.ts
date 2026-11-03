import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import type { CompiledRule } from '../config/config-snapshot'
import {
  CEL_LIMITS,
  type EvaluationResult,
  type RuleError,
} from './rule-engine'

/** Deadline for Worker startup and for running one rule */
export interface RuleEvaluatorOptions {
  timeoutMs?: number
  startupTimeoutMs?: number
}

// Config-derived expressions are sent via structured clone, never interpolated into executable code.
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

/** Evaluates CEL in a Worker with a deadline; only the problematic rule is treated as non-matching */
export class RuleEvaluator {
  private readonly timeoutMs: number
  private readonly startupTimeoutMs: number
  private worker: Worker | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private stopped = false

  /** Sets the evaluation deadline */
  constructor(options: RuleEvaluatorOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 100
    this.startupTimeoutMs = options.startupTimeoutMs ?? 2000
  }

  /** Serializes evaluation across events so responses from the same Worker are not mixed up */
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

  /** Stops the Worker in use */
  async stop(): Promise<void> {
    this.stopped = true
    await this.discardWorker()
  }

  /** After a rule times out, discards the Worker and continues with later rules in a fresh one */
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

  /** Worker initialization is awaited with a deadline separate from rule execution */
  private async getWorker(): Promise<Worker> {
    if (this.stopped) throw new Error('Rule evaluator stopped')
    if (this.worker) return this.worker
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        // Resolve dependencies from this module under both CommonJS and ts-jest.
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
    // Outside of waiting, the Worker does not keep the process alive.
    worker.unref()
    const result = await this.receive(worker, this.startupTimeoutMs)
    if (!result.ready) throw new Error('Rule worker failed to initialize')
    return worker
  }

  /** Waits for one Worker response, always removing the listeners */
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
        // Delay the reject by one tick so an already-answered evaluation is not misjudged as timed out by a main thread stall
        setImmediate(() => {
          reject(new Error(`Rule evaluation timed out after ${timeoutMs}ms`))
        })
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

  /** Terminates the timed-out work together with its OS thread */
  private async discardWorker(): Promise<void> {
    const worker = this.worker
    this.worker = undefined
    if (worker) await worker.terminate()
  }
}
