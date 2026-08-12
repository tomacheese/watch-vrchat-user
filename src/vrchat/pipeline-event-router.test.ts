import { EventEmitter } from 'node:events'
import { PipelineEventRouter } from './pipeline-event-router'
import { UserStateCoordinator } from '../state/user-state-coordinator'
import { UserStateRepository } from '../state/user-state-repository'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

function tempFilePath(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'router-')),
    'user-locations.json'
  )
}

describe('PipelineEventRouter', () => {
  it('対象ユーザーの friend-location を coordinator へ enqueue する', () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    const coordinator = new UserStateCoordinator(repository, async () => {})
    const enqueueSpy = jest.spyOn(coordinator, 'enqueue')
    const router = new PipelineEventRouter(['usr_1'], coordinator)
    const pipeline = new EventEmitter() as unknown as EventEmitter & {
      removeAllListeners: (event: string) => void
    }
    router.attach(pipeline)

    pipeline.emit('friend-location', {
      userId: 'usr_1',
      user: { id: 'usr_1', displayName: 'Alice' },
      location: 'wrld_a',
    })

    expect(enqueueSpy).toHaveBeenCalledWith('usr_1', 'Alice', {
      type: 'location',
      location: 'wrld_a',
    })
  })

  it('対象外ユーザーの event は無視する', () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    const coordinator = new UserStateCoordinator(repository, async () => {})
    const enqueueSpy = jest.spyOn(coordinator, 'enqueue')
    const router = new PipelineEventRouter(['usr_1'], coordinator)
    const pipeline = new EventEmitter() as unknown as EventEmitter & {
      removeAllListeners: (event: string) => void
    }
    router.attach(pipeline)

    pipeline.emit('friend-online', {
      userId: 'usr_2',
      user: { id: 'usr_2', displayName: 'Bob' },
    })

    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('不正な payload は enqueue せず無視する', () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    const coordinator = new UserStateCoordinator(repository, async () => {})
    const enqueueSpy = jest.spyOn(coordinator, 'enqueue')
    const router = new PipelineEventRouter(['usr_1'], coordinator)
    const pipeline = new EventEmitter() as unknown as EventEmitter & {
      removeAllListeners: (event: string) => void
    }
    router.attach(pipeline)

    pipeline.emit('friend-online', { unexpected: true })

    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('friend-offline はフォールバック displayName で enqueue する', () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    const coordinator = new UserStateCoordinator(repository, async () => {})
    const enqueueSpy = jest.spyOn(coordinator, 'enqueue')
    const router = new PipelineEventRouter(['usr_1'], coordinator)
    const pipeline = new EventEmitter() as unknown as EventEmitter & {
      removeAllListeners: (event: string) => void
    }
    router.attach(pipeline)

    pipeline.emit('friend-offline', { userId: 'usr_1' })

    expect(enqueueSpy).toHaveBeenCalledWith('usr_1', 'usr_1', {
      type: 'offline',
    })
  })
})
