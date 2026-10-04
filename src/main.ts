import './env'
import { Logger } from '@book000/node-utils'
import { App } from './app'
import { loadConfig } from './config'
import { toError } from './logger-utils'

const logger = Logger.configure('MAIN')

/**
 * エントリポイント
 */
async function main(): Promise<void> {
  const config = loadConfig()
  const app = new App(config)

  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info('Shutting down...')
    const deadline = setTimeout(() => {
      logger.error('Shutdown exceeded its deadline')
      // eslint-disable-next-line unicorn/no-process-exit
      process.exit(1)
    }, 15_000)
    deadline.unref()
    app
      .stop()
      .catch((error: unknown) => {
        logger.error('Error during shutdown', toError(error))
        process.exitCode = 1
      })
      .finally(() => {
        clearTimeout(deadline)
        Logger.closeAll()
        process.exitCode ??= 0
      })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await app.start()
}

main().catch((error: unknown) => {
  logger.error('Fatal error', toError(error))
  Logger.closeAll()
  process.exitCode = 1
})
