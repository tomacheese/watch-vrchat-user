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

  const shutdown = (): void => {
    logger.info('Shutting down...')
    app
      .stop()
      .catch((error: unknown) => {
        logger.error('Error during shutdown', toError(error))
      })
      .finally(() => {
        Logger.closeAll()
        // eslint-disable-next-line unicorn/no-process-exit
        process.exit(0)
      })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await app.start()
}

main().catch((error: unknown) => {
  logger.error('Fatal error', toError(error))
  Logger.closeAll()
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(1)
})
