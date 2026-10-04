import './env'
import { UserStateRepository } from './state/user-state-repository'

/** 停止中の通知予定を確認し、管理者が送達不明・永久失敗から復旧する */
async function main(): Promise<void> {
  const [command, id, destination, ...extra] = process.argv.slice(2) as (
    string | undefined
  )[]
  if (
    extra.length > 0 ||
    !['list', 'retry', 'discard'].includes(command ?? '') ||
    (command === 'list' ? id !== undefined : !id)
  ) {
    throw new Error(
      'Usage: pnpm outbox list | retry <id> [<destination>] | discard <id> [<destination>]'
    )
  }
  const repository = new UserStateRepository(undefined, { exclusive: true })
  try {
    repository.load()
    if (command === 'list') {
      console.log(
        JSON.stringify(
          repository.getPendingEffects().map((entry) => ({
            id: entry.id,
            createdAt: entry.createdAt,
            error: entry.error,
            deliveries: entry.deliveries?.map(({ name, status, attempts }) => ({
              name,
              status,
              attempts,
            })),
          })),
          null,
          2
        )
      )
      return
    }
    const entry = repository.getPendingEffects().find((item) => item.id === id)
    if (!entry) throw new Error('Persisted notification was not found')
    if (!destination) {
      if (command === 'discard') await repository.removePendingEffect(entry.id)
      else if (entry.error && entry.deliveries === undefined)
        await repository.updatePendingEffect({ ...entry, error: undefined })
      else throw new Error('Choose a destination to retry')
      console.log(
        command === 'retry'
          ? 'Notification preparation queued'
          : 'Notification discarded'
      )
      return
    }
    if (!entry.deliveries?.some((delivery) => delivery.name === destination))
      throw new Error('Persisted delivery was not found')
    const deliveries = entry.deliveries.map((delivery) => {
      if (delivery.name !== destination) return delivery
      if (delivery.status === 'delivered')
        throw new Error('Delivery is already complete')
      return {
        ...delivery,
        status:
          command === 'retry' ? ('pending' as const) : ('delivered' as const),
        nextAttemptAt: undefined,
        lastError: undefined,
      }
    })
    if (deliveries.every((delivery) => delivery.status === 'delivered'))
      await repository.removePendingEffect(entry.id)
    else await repository.updatePendingEffect({ ...entry, deliveries })
    console.log(
      command === 'retry'
        ? 'Delivery queued; retry may duplicate a previously accepted notification'
        : 'Delivery discarded'
    )
  } finally {
    repository.close()
  }
}

main().catch(() => {
  // 外部エラーに含まれ得る URL や本文を CLI へ出さない。
  console.error(
    'Outbox recovery failed; check the arguments and stop the application first'
  )
  process.exitCode = 1
})
