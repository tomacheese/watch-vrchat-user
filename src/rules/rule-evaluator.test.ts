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
