import { DiscordNotifier } from './discord-notifier'
import type { Config } from '../config'

const config: Config = {
  vrchat: { username: 'u', password: 'p' },
  discord: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
  targetUserIds: ['usr_1'],
}

describe('DiscordNotifier', () => {
  it('sendMessage がタイムアウトした場合はリトライし、最終的に諦めて例外を伝播しない', async () => {
    const notifier = new DiscordNotifier(config)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const discord = (notifier as any).discord as { sendMessage: jest.Mock }
    discord.sendMessage = jest.fn(
      () => new Promise((resolve) => setTimeout(resolve, 100))
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(notifier as any).timeoutMs = 10
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(notifier as any).retryDelayMs = 1

    await expect(
      notifier.notifyOnline({ displayName: 'Alice', userId: 'usr_1' })
    ).resolves.toBeUndefined()
    expect(discord.sendMessage).toHaveBeenCalledTimes(3)
  })

  it('notifyLocationChange は成功時に 1 回だけ sendMessage を呼ぶ', async () => {
    const notifier = new DiscordNotifier(config)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const discord = (notifier as any).discord as { sendMessage: jest.Mock }
    discord.sendMessage = jest.fn().mockResolvedValue(undefined)

    await notifier.notifyLocationChange({
      displayName: 'Alice',
      userId: 'usr_1',
      previousLocation: 'wrld_a',
      currentLocation: 'wrld_b',
    })

    expect(discord.sendMessage).toHaveBeenCalledTimes(1)
  })
})
