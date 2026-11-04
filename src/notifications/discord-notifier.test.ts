import { DeliveryError, DiscordNotifier } from './discord-notifier'

jest.mock('@book000/node-utils', () => ({
  Logger: { configure: () => ({ error: jest.fn() }) },
}))
const URL = 'https://discord.com/api/webhooks/1/secret'
const embed = { title: 't' }

/** HTTP response for tests */
function response(status = 200, retryAfter?: number): Response {
  return new Response(
    status === 200 ? '{}' : JSON.stringify({ retry_after: retryAfter }),
    {
      status,
      headers:
        retryAfter === undefined ? {} : { 'Retry-After': String(retryAfter) },
    }
  )
}

describe('DiscordNotifier', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('the delivery deadline aborts the request and an uncertain POST is not retried', async () => {
    let signal: AbortSignal | undefined
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((_input, options) => {
        signal = options?.signal ?? undefined
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new Error('aborted'))
          })
        })
      })
    const notifier = new DiscordNotifier({ timeoutMs: 10 })
    await expect(notifier.send('main', URL, embed)).rejects.toMatchObject({
      uncertain: true,
    })
    expect(signal?.aborted).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    notifier.stop()
  })

  it('serializes different destinations that share a URL', async () => {
    const { promise, resolve: release } = Promise.withResolvers<undefined>()
    const sendMessage = jest
      .fn()
      .mockImplementationOnce(() => promise)
      .mockResolvedValue(undefined)
    const notifier = new DiscordNotifier({
      createClient: () => ({ sendMessage }),
    })
    const first = notifier.send('a', URL, embed)
    const second = notifier.send('b', URL, embed)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(sendMessage).toHaveBeenCalledTimes(1)
    release(undefined)
    await Promise.all([first, second])
    expect(sendMessage).toHaveBeenCalledTimes(2)
    notifier.stop()
  })

  it('waits for the period specified by a 429 and retries', async () => {
    const times: number[] = []
    jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
      times.push(Date.now())
      return Promise.resolve(
        response(
          times.length === 1 ? 429 : 200,
          times.length === 1 ? 0.04 : undefined
        )
      )
    })
    const notifier = new DiscordNotifier()
    await notifier.send('main', URL, embed)
    expect(times).toHaveLength(2)
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(35)
    notifier.stop()
  })

  it('5xx returns a retry to the outbox and an invalid Webhook returns a permanent failure', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(404))
    const notifier = new DiscordNotifier()
    await expect(notifier.send('main', URL, embed)).rejects.toMatchObject({
      status: 503,
      uncertain: false,
      permanent: false,
    })
    await expect(notifier.send('main', URL, embed)).rejects.toMatchObject({
      status: 404,
      permanent: true,
    })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    notifier.stop()
  })

  it('shutdown also ends a long rate-limit wait', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(response(429, 60))
    const notifier = new DiscordNotifier()
    const send = notifier.send('main', URL, embed)
    const result = expect(send).rejects.toMatchObject({
      stopped: true,
      uncertain: false,
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    notifier.stop()
    await result
  })

  it('secrets in an unknown network error are not exposed', async () => {
    const notifier = new DiscordNotifier({
      createClient: () => ({
        sendMessage: () => Promise.reject(new Error(`bad ${URL}`)),
      }),
    })
    try {
      await notifier.send('main', URL, embed)
      throw new Error('expected rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(DeliveryError)
      expect((error as Error).message).not.toContain('secret')
    }
    notifier.stop()
  })
})
