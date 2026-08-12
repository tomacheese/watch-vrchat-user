import { DiscordNotifier } from './discord-notifier'
import type { Config } from '../config'

// private field (discord/timeoutMs/retryDelayMs) をテストから差し替えるための最小限のアクセサ型
interface DiscordNotifierTestAccessor {
  discord: { sendMessage: jest.Mock }
  timeoutMs: number
  retryDelayMs: number
}

const config: Config = {
  vrchat: { username: 'u', password: 'p' },
  discord: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
  targetUserIds: ['usr_1'],
}

describe('DiscordNotifier', () => {
  it('sendMessage がタイムアウトした場合はリトライし、最終的に諦めて例外を伝播しない', async () => {
    const notifier = new DiscordNotifier(config)
    const accessor = notifier as unknown as DiscordNotifierTestAccessor
    const discord = accessor.discord
    discord.sendMessage = jest.fn(
      () => new Promise((resolve) => setTimeout(resolve, 100))
    )

    accessor.timeoutMs = 10
    accessor.retryDelayMs = 1

    await expect(
      notifier.notifyOnline({ displayName: 'Alice', userId: 'usr_1' })
    ).resolves.toBeUndefined()
    expect(discord.sendMessage).toHaveBeenCalledTimes(3)
  })

  it('notifyLocationChange は成功時に 1 回だけ sendMessage を呼ぶ', async () => {
    const notifier = new DiscordNotifier(config)
    const accessor = notifier as unknown as DiscordNotifierTestAccessor
    const discord = accessor.discord
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
