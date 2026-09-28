import { Discord, Logger, type DiscordEmbed } from '@book000/node-utils'
import { toError } from '../logger-utils'

const logger = Logger.configure('DISCORD')

/** Embed を送信できるクライアント */
export interface EmbedClient {
  sendMessage(message: { embeds: DiscordEmbed[] }): Promise<unknown>
}

/** DiscordNotifier の生成オプション */
export interface DiscordNotifierOptions {
  /** Webhook URL からクライアントを生成する関数 */
  createClient?: (url: string) => EmbedClient
  /** 1 回の送信のタイムアウト (ms) */
  timeoutMs?: number
  /** リトライ間隔の基準値 (ms)。試行回数に比例して延びる */
  retryDelayMs?: number
}

/**
 * destination ごとに Discord Webhook へ Embed を送信するクラス
 *
 * URL が変わらない限り destination ごとに同じクライアントを再利用する。
 */
export class DiscordNotifier {
  private readonly clients = new Map<
    string,
    { url: string; client: EmbedClient }
  >()
  private readonly createClient: (url: string) => EmbedClient
  private readonly timeoutMs: number
  private readonly retryDelayMs: number

  /**
   * DiscordNotifier を初期化する
   *
   * @param options クライアント生成関数・タイムアウト・リトライ間隔
   */
  constructor(options: DiscordNotifierOptions = {}) {
    this.createClient =
      options.createClient ?? ((url) => new Discord({ webhookUrl: url }))
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.retryDelayMs = options.retryDelayMs ?? 1000
  }

  /**
   * Embed を送信する（bounded timeout + リトライ付き）
   *
   * 失敗はログにのみ出力し、呼び出し元へは伝播しない。
   *
   * @param destinationName destination 名
   * @param url Webhook URL
   * @param embed 送信する Embed
   */
  async send(
    destinationName: string,
    url: string,
    embed: DiscordEmbed
  ): Promise<void> {
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.withTimeout(
          this.getClient(destinationName, url).sendMessage({ embeds: [embed] })
        )
        return
      } catch (error) {
        // URL（秘密情報）がエラー文言に含まれていてもログへ出さない
        const message = toError(error).message.split(url).join('[redacted]')
        logger.error(
          `Failed to send notification to "${destinationName}" (attempt ${attempt}/${maxAttempts})`,
          new Error(message)
        )
        if (attempt < maxAttempts) {
          await this.delay(this.retryDelayMs * attempt)
        }
      }
    }
  }

  /**
   * destination のクライアントを取得する。URL が変わっていれば作り直す
   *
   * @param name destination 名
   * @param url Webhook URL
   * @returns 再利用または新規生成したクライアント
   */
  private getClient(name: string, url: string): EmbedClient {
    const cached = this.clients.get(name)
    if (cached?.url === url) return cached.client
    const client = this.createClient(url)
    this.clients.set(name, { url, client })
    return client
  }

  /**
   * Promise に送信タイムアウトを付与する
   *
   * @param promise 対象の Promise
   * @returns 元の Promise の結果
   */
  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Discord send timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 指定ミリ秒だけ待機する
   *
   * @param ms 待機するミリ秒
   */
  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
