import { DiscordNotifier, type EmbedClient } from './discord-notifier'

const errorLog = jest.fn<undefined, unknown[]>()
jest.mock('@book000/node-utils', () => ({
  Logger: {
    configure: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: (...args: unknown[]) => {
        errorLog(...args)
      },
    }),
  },
  Discord: jest.fn(),
}))

const URL_A = 'https://discord.com/api/webhooks/1/secret-a'
const embed = { title: 't' }

describe('DiscordNotifier', () => {
  beforeEach(() => {
    errorLog.mockClear()
  })

  it('タイムアウト時はリトライし、最終的に諦めて例外を伝播しない', async () => {
    const sendMessage = jest.fn(
      () => new Promise((resolve) => setTimeout(resolve, 100))
    )
    const notifier = new DiscordNotifier({
      createClient: () => ({ sendMessage }),
      timeoutMs: 10,
      retryDelayMs: 1,
    })
    await expect(notifier.send('main', URL_A, embed)).resolves.toBeUndefined()
    expect(sendMessage).toHaveBeenCalledTimes(3)
  })

  it('成功時は 1 回だけ送信し、同じ URL ならクライアントを再利用する', async () => {
    const sendMessage = jest.fn().mockResolvedValue(undefined)
    const createClient = jest.fn((): EmbedClient => ({ sendMessage }))
    const notifier = new DiscordNotifier({ createClient })
    await notifier.send('main', URL_A, embed)
    await notifier.send('main', URL_A, embed)
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(createClient).toHaveBeenCalledTimes(1)
    await notifier.send('main', `${URL_A}x`, embed)
    expect(createClient).toHaveBeenCalledTimes(2)
  })

  it('エラー文言に含まれる URL はログに出さない', async () => {
    const notifier = new DiscordNotifier({
      createClient: () => ({
        sendMessage: jest.fn().mockRejectedValue(new Error(`bad ${URL_A}`)),
      }),
      retryDelayMs: 1,
    })
    await notifier.send('main', URL_A, embed)
    expect(errorLog).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('secret-a')
    expect((errorLog.mock.calls[0][1] as Error).message).toBe('bad [redacted]')
  })
})
