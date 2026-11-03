import { compileRules } from './rule-engine'
import { RuleEvaluator } from './rule-evaluator'

/** CEL の compile 対象 */
function rules(expressions: string[]) {
  return compileRules(
    expressions.map((when, i) => ({
      name: `r${i}`,
      enabled: true,
      destinations: ['main'],
      when,
    }))
  )
}

describe('RuleEvaluator', () => {
  it('Worker へ bigint とコンテキストを渡し、複数イベントも正しく評価する', async () => {
    const evaluator = new RuleEvaluator()
    try {
      const compiled = rules(['event.hour >= 22', 'user.id == "u"'])
      const results = await Promise.all([
        evaluator.evaluate(compiled, {
          event: { hour: 23n },
          user: { id: 'u' },
        }),
        evaluator.evaluate(compiled, {
          event: { hour: 10n },
          user: { id: 'v' },
        }),
      ])
      expect(results[0]).toEqual({ matched: ['r0', 'r1'], errors: [] })
      expect(results[1]).toEqual({ matched: [], errors: [] })
    } finally {
      await evaluator.stop()
    }
  })

  it('危険な正規表現を期限で止め、後続のルールとイベントを継続する', async () => {
    const evaluator = new RuleEvaluator({ timeoutMs: 30 })
    try {
      const compiled = rules([
        'current.statusDescription.matches("^(a+)+$")',
        'true',
      ])
      const result = await evaluator.evaluate(compiled, {
        current: { statusDescription: `${'a'.repeat(80)}!` },
      })
      expect(result.matched).toEqual(['r1'])
      expect(result.errors[0]).toMatchObject({
        rule: 'r0',
        kind: 'evaluation',
        message: expect.stringContaining('timed out'),
      })
      expect(await evaluator.evaluate(rules(['true']), {})).toEqual({
        matched: ['r0'],
        errors: [],
      })
    } finally {
      await evaluator.stop()
    }
  })

  it('評価依頼の直後に main thread が期限を超えて停止しても、応答済みの評価を期限切れにしない', async () => {
    const timeoutMs = 200
    const evaluator = new RuleEvaluator({ timeoutMs })
    try {
      const compiled = rules(['user.id == "u"'])
      const context = { user: { id: 'u' } }
      // Worker の起動と式の parse を済ませ、以降の評価を十分速くしておく
      expect(await evaluator.evaluate(compiled, context)).toEqual({
        matched: ['r0'],
        errors: [],
      })

      // 同期 I/O（SQLite の commit など）を模して、postMessage の直後に期限の 3 倍だけ止める
      setImmediate(() => {
        const end = Date.now() + timeoutMs * 3
        while (Date.now() < end) {
          // 同期的に待つ
        }
      })
      expect(await evaluator.evaluate(compiled, context)).toEqual({
        matched: ['r0'],
        errors: [],
      })
    } finally {
      await evaluator.stop()
    }
  })

  it('元の式がないルールは同期実行に戻らず、評価エラーにする', async () => {
    const evaluator = new RuleEvaluator()
    try {
      const result = await evaluator.evaluate(
        [
          {
            name: 'r',
            enabled: true,
            destinations: [],
            program: () => {
              throw new Error('must not run')
            },
          },
        ],
        {}
      )
      expect(result.errors[0].message).toBe('Rule expression is unavailable')
    } finally {
      await evaluator.stop()
    }
  })
})
