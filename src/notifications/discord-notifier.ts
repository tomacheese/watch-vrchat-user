import { Logger, type DiscordEmbed } from '@book000/node-utils'

const logger = Logger.configure('DISCORD')

/** Delivery error distinguishing HTTP responses from delivery outcomes. Holds no secrets */
export class DeliveryError extends Error {
  /** Initializes the delivery error classification */
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
    readonly uncertain = false,
    readonly permanent = false,
    readonly stopped = false
  ) {
    super(message)
    this.name = 'DeliveryError'
  }
}

/** Abortable Embed delivery client */
export interface EmbedClient {
  sendMessage(
    message: { embeds: DiscordEmbed[] },
    signal?: AbortSignal
  ): Promise<unknown>
}

/** Options for creating a DiscordNotifier */
export interface DiscordNotifierOptions {
  createClient?: (url: string) => EmbedClient
  timeoutMs?: number
  retryDelayMs?: number
}

/** Serializes deliveries per Webhook and returns the HTTP delivery outcome to the caller */
export class DiscordNotifier {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly blockedUntil = new Map<string, number>()
  private readonly controllers = new Set<AbortController>()
  private readonly createClient?: (url: string) => EmbedClient
  private readonly timeoutMs: number
  private readonly retryDelayMs: number
  private stopped = false

  /** Sets the delivery deadline and the transport implementation (replaceable in tests) */
  constructor(options: DiscordNotifierOptions = {}) {
    this.createClient = options.createClient
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.retryDelayMs = options.retryDelayMs ?? 1000
  }

  /** Appends a delivery to the queue for the same URL */
  async send(name: string, url: string, embed: DiscordEmbed): Promise<void> {
    const previous = this.queues.get(url) ?? Promise.resolve()
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.stopped)
          throw new DeliveryError(
            'Discord notifier stopped',
            undefined,
            undefined,
            false,
            false,
            true
          )
        await this.deliver(name, url, embed)
      })
    this.queues.set(url, operation)
    try {
      await operation
    } finally {
      if (this.queues.get(url) === operation) this.queues.delete(url)
    }
  }

  /** Aborts requests and rate-limit waits */
  stop(): void {
    this.stopped = true
    for (const controller of this.controllers) controller.abort()
    this.blockedUntil.clear()
  }

  /** Retries only an explicit 429 rejection; an unknown outcome is left to the outbox to decide */
  private async deliver(
    name: string,
    url: string,
    embed: DiscordEmbed
  ): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await this.wait(
        Math.max(0, (this.blockedUntil.get(url) ?? 0) - Date.now())
      )
      try {
        await this.request(url, embed)
        return
      } catch (error) {
        const failure =
          error instanceof DeliveryError
            ? error
            : new DeliveryError(
                'Discord delivery outcome is unknown',
                undefined,
                undefined,
                true
              )
        logger.error(
          `Failed to send notification to "${name}": ${failure.message}`
        )
        if (failure.status !== 429) throw failure
        const delay = failure.retryAfterMs ?? this.retryDelayMs * attempt
        this.blockedUntil.set(url, Date.now() + delay)
        if (attempt === 3) throw failure
      }
    }
  }

  /** Performs the HTTP request with a deadline; ambiguous failures are not retried */
  private async request(url: string, embed: DiscordEmbed): Promise<void> {
    if (this.stopped)
      throw new DeliveryError(
        'Discord notifier stopped',
        undefined,
        undefined,
        false,
        false,
        true
      )
    const controller = new AbortController()
    this.controllers.add(controller)
    let timer: NodeJS.Timeout | undefined
    let onAbort: (() => void) | undefined
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          reject(
            new DeliveryError(
              'Discord delivery outcome is unknown after cancellation',
              undefined,
              undefined,
              true,
              false,
              this.stopped
            )
          )
        }
        controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      timer = setTimeout(() => {
        controller.abort()
      }, this.timeoutMs)
      const operation = this.createClient
        ? this.createClient(url).sendMessage(
            { embeds: [embed] },
            controller.signal
          )
        : this.post(url, embed, controller.signal)
      await Promise.race([operation, aborted])
    } catch (error) {
      if (error instanceof DeliveryError) throw error
      // Network exceptions may contain the URL, so the original message is not exposed.
      throw new DeliveryError(
        'Discord delivery outcome is unknown',
        undefined,
        undefined,
        true
      )
    } finally {
      clearTimeout(timer)
      if (onAbort) controller.signal.removeEventListener('abort', onAbort)
      this.controllers.delete(controller)
    }
  }

  /** Structures successful responses and HTTP failures */
  private async post(
    url: string,
    embed: DiscordEmbed,
    signal: AbortSignal
  ): Promise<void> {
    const target = new URL(url)
    target.searchParams.set('wait', 'true')
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [embed],
        allowed_mentions: { parse: [] },
      }),
      signal,
    })
    if (response.ok) {
      await response.body?.cancel()
      return
    }
    let retryAfterMs: number | undefined
    if (response.status === 429) {
      const header = Number(response.headers.get('retry-after'))
      if (Number.isFinite(header) && header > 0)
        retryAfterMs = Math.ceil(header * 1000)
      try {
        const body = (await response.json()) as { retry_after?: unknown }
        if (
          typeof body.retry_after === 'number' &&
          Number.isFinite(body.retry_after) &&
          body.retry_after > 0
        ) {
          retryAfterMs = Math.max(
            retryAfterMs ?? 0,
            Math.ceil(body.retry_after * 1000)
          )
        }
      } catch {
        // Keep the header wait time even if the body is malformed.
      }
    } else {
      await response.body?.cancel()
    }
    throw new DeliveryError(
      `Discord API returned ${response.status}`,
      response.status,
      retryAfterMs,
      false,
      response.status >= 400 && response.status < 500 && response.status !== 429
    )
  }

  /** Wait that can be interrupted by shutdown */
  private async wait(ms: number): Promise<void> {
    if (this.stopped)
      throw new DeliveryError(
        'Discord notifier stopped',
        undefined,
        undefined,
        false,
        false,
        true
      )
    if (ms <= 0) return
    const controller = new AbortController()
    this.controllers.add(controller)
    try {
      const { promise, resolve, reject } = Promise.withResolvers<undefined>()
      const abort = () => {
        reject(
          new DeliveryError(
            'Discord notifier stopped',
            undefined,
            undefined,
            false,
            false,
            true
          )
        )
      }
      const timer = setTimeout(resolve, ms, undefined)
      controller.signal.addEventListener('abort', abort, { once: true })
      try {
        await promise
      } finally {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', abort)
      }
    } finally {
      this.controllers.delete(controller)
    }
  }
}
