import { compileRules } from './rule-engine'
import { RuleEvaluator } from './rule-evaluator'

/** CEL expression to compile */
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
  it('passes bigint and context to the Worker and evaluates multiple events correctly', async () => {
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

  it('stops a dangerous regex at the deadline and continues with later rules and events', async () => {
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

  it('does not time out an already-answered evaluation when the main thread stalls past the deadline right after the request', async () => {
    const timeoutMs = 200
    const evaluator = new RuleEvaluator({ timeoutMs })
    try {
      const compiled = rules(['user.id == "u"'])
      const context = { user: { id: 'u' } }
      // Finish Worker startup and expression parsing so later evaluations are fast enough
      expect(await evaluator.evaluate(compiled, context)).toEqual({
        matched: ['r0'],
        errors: [],
      })

      // Simulate synchronous I/O (e.g. a SQLite commit) by blocking for 3x the deadline right after postMessage
      setImmediate(() => {
        const end = Date.now() + timeoutMs * 3
        while (Date.now() < end) {
          // Wait synchronously
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

  it('a rule without its original expression is an evaluation error instead of falling back to synchronous execution', async () => {
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
