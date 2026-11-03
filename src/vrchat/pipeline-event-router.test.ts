import { EventEmitter } from 'node:events'
import { PipelineEventRouter } from './pipeline-event-router'
import { UserStateCoordinator } from '../state/user-state-coordinator'
import { UserStateRepository } from '../state/user-state-repository'
import * as fs from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import type { PipelineEventEmitterLike } from './pipeline-event-router'
import type { ConfigSnapshot } from '../config/config-snapshot'

const snapshot: ConfigSnapshot = {
  destinations: {},
  rules: [],
  loadedAt: '2026-01-01T00:00:00.000Z',
}

function tempFilePath(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'router-')),
    'friend-states.json'
  )
}

// The VRChat SDK's pipeline has a Node-style EventEmitter API, so the fake
// follows it (an EventTarget does not match the on()/emit() shape).
function fakePipeline(): PipelineEventEmitterLike & EventEmitter {
  // eslint-disable-next-line unicorn/prefer-event-target
  return new EventEmitter()
}

describe('PipelineEventRouter', () => {
  it('enqueues a friend-location for the user to the coordinator', () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    const coordinator = new UserStateCoordinator(
      repository,
      () => Promise.resolve(),
      () => snapshot
    )
    const enqueueSpy = jest.spyOn(coordinator, 'enqueue')
    const router = new PipelineEventRouter(coordinator)
    const pipeline = fakePipeline()
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

  it('handles events of all users (no targetUserIds filter)', () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    const coordinator = new UserStateCoordinator(
      repository,
      () => Promise.resolve(),
      () => snapshot
    )
    const enqueueSpy = jest.spyOn(coordinator, 'enqueue')
    const router = new PipelineEventRouter(coordinator)
    const pipeline = fakePipeline()
    router.attach(pipeline)

    pipeline.emit('friend-online', {
      userId: 'usr_2',
      user: { id: 'usr_2', displayName: 'Bob' },
    })

    expect(enqueueSpy).toHaveBeenCalledWith('usr_2', 'Bob', { type: 'online' })
  })

  it('puts a usable friend-online location on the online observation', () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    const coordinator = new UserStateCoordinator(
      repository,
      () => Promise.resolve(),
      () => snapshot
    )
    const enqueueSpy = jest.spyOn(coordinator, 'enqueue')
    const router = new PipelineEventRouter(coordinator)
    const pipeline = fakePipeline()
    router.attach(pipeline)

    const user = { id: 'usr_1', displayName: 'Alice' }
    pipeline.emit('friend-online', {
      userId: 'usr_1',
      user,
      location: 'wrld_a:1',
    })
    pipeline.emit('friend-online', {
      userId: 'usr_1',
      user,
      location: 'offline',
    })
    pipeline.emit('friend-online', {
      userId: 'usr_1',
      user,
      location: 'traveling:traveling',
    })
    pipeline.emit('friend-online', { userId: 'usr_1', user, location: 42 })

    expect(enqueueSpy.mock.calls.map((call) => call[2])).toEqual([
      { type: 'online', location: 'wrld_a:1' },
      { type: 'online' },
      { type: 'online' },
      { type: 'online' },
    ])
  })

  it('enqueues friend-add / friend-delete as observations', () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    const coordinator = new UserStateCoordinator(
      repository,
      () => Promise.resolve(),
      () => snapshot
    )
    const enqueueSpy = jest.spyOn(coordinator, 'enqueue')
    const router = new PipelineEventRouter(coordinator)
    const pipeline = fakePipeline()
    router.attach(pipeline)

    pipeline.emit('friend-add', {
      userId: 'usr_3',
      user: { id: 'usr_3', displayName: 'Carol' },
    })
    pipeline.emit('friend-delete', { userId: 'usr_3' })

    expect(enqueueSpy).toHaveBeenNthCalledWith(1, 'usr_3', 'Carol', {
      type: 'friend-add',
    })
    expect(enqueueSpy).toHaveBeenNthCalledWith(2, 'usr_3', 'usr_3', {
      type: 'friend-delete',
    })
  })

  it('ignores invalid friend-add / friend-delete payloads', () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    const coordinator = new UserStateCoordinator(
      repository,
      () => Promise.resolve(),
      () => snapshot
    )
    const enqueueSpy = jest.spyOn(coordinator, 'enqueue')
    const router = new PipelineEventRouter(coordinator)
    const pipeline = fakePipeline()
    router.attach(pipeline)

    pipeline.emit('friend-add', { userId: 'usr_3' })
    pipeline.emit('friend-add', null)
    pipeline.emit('friend-delete', {})
    pipeline.emit('friend-delete', 'usr_3')

    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('enqueues the friend-update status as a profile observation', () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    const coordinator = new UserStateCoordinator(
      repository,
      () => Promise.resolve(),
      () => snapshot
    )
    const enqueueSpy = jest.spyOn(coordinator, 'enqueue')
    const router = new PipelineEventRouter(coordinator)
    const pipeline = fakePipeline()
    router.attach(pipeline)

    pipeline.emit('friend-update', {
      userId: 'usr_4',
      user: {
        id: 'usr_4',
        displayName: 'Dave',
        status: 'busy',
        statusDescription: '作業中',
      },
    })
    // Updates without status (bio / avatar etc.) and invalid payloads are ignored
    pipeline.emit('friend-update', {
      userId: 'usr_4',
      user: { id: 'usr_4', displayName: 'Dave' },
    })
    pipeline.emit('friend-update', null)

    expect(enqueueSpy).toHaveBeenCalledTimes(1)
    expect(enqueueSpy).toHaveBeenCalledWith('usr_4', 'Dave', {
      type: 'profile',
      profile: { status: 'busy', statusDescription: '作業中' },
    })
  })

  it('extracts the status from the user of friend-online / friend-location', () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    const coordinator = new UserStateCoordinator(
      repository,
      () => Promise.resolve(),
      () => snapshot
    )
    const enqueueSpy = jest.spyOn(coordinator, 'enqueue')
    const router = new PipelineEventRouter(coordinator)
    const pipeline = fakePipeline()
    router.attach(pipeline)
    const user = {
      id: 'usr_5',
      displayName: 'Eve',
      status: 'ask me',
      statusDescription: 'hi',
    }
    const profile = { status: 'ask me', statusDescription: 'hi' }

    pipeline.emit('friend-online', { userId: 'usr_5', user })
    pipeline.emit('friend-location', {
      userId: 'usr_5',
      user,
      location: 'wrld_a:1',
    })

    expect(enqueueSpy).toHaveBeenNthCalledWith(1, 'usr_5', 'Eve', {
      type: 'online',
      profile,
    })
    expect(enqueueSpy).toHaveBeenNthCalledWith(2, 'usr_5', 'Eve', {
      type: 'location',
      location: 'wrld_a:1',
      profile,
    })
  })

  it('does not duplicate listeners when attach is called again', () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    const coordinator = new UserStateCoordinator(
      repository,
      () => Promise.resolve(),
      () => snapshot
    )
    const enqueueSpy = jest.spyOn(coordinator, 'enqueue')
    const router = new PipelineEventRouter(coordinator)
    const pipeline = fakePipeline()
    router.attach(pipeline)
    router.attach(pipeline)

    pipeline.emit('friend-delete', { userId: 'usr_3' })

    expect(enqueueSpy).toHaveBeenCalledTimes(1)
  })

  it('ignores invalid payloads without enqueueing', () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    const coordinator = new UserStateCoordinator(
      repository,
      () => Promise.resolve(),
      () => snapshot
    )
    const enqueueSpy = jest.spyOn(coordinator, 'enqueue')
    const router = new PipelineEventRouter(coordinator)
    const pipeline = fakePipeline()
    router.attach(pipeline)

    pipeline.emit('friend-online', { unexpected: true })

    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('enqueues friend-offline with the fallback displayName', () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    const coordinator = new UserStateCoordinator(
      repository,
      () => Promise.resolve(),
      () => snapshot
    )
    const enqueueSpy = jest.spyOn(coordinator, 'enqueue')
    const router = new PipelineEventRouter(coordinator)
    const pipeline = fakePipeline()
    router.attach(pipeline)

    pipeline.emit('friend-offline', { userId: 'usr_1' })

    expect(enqueueSpy).toHaveBeenCalledWith('usr_1', 'usr_1', {
      type: 'offline',
    })
  })
})

describe('router lifecycle', () => {
  it("detach removes its own listeners and keeps other users' listeners", () => {
    const repository = new UserStateRepository(tempFilePath())
    const coordinator = new UserStateCoordinator(
      repository,
      () => Promise.resolve(),
      () => snapshot
    )
    const enqueue = jest
      .spyOn(coordinator, 'enqueue')
      .mockImplementation(() => undefined)
    const pipeline = fakePipeline()
    const otherListener = jest.fn()
    pipeline.on('friend-delete', otherListener)
    const router = new PipelineEventRouter(coordinator)
    router.attach(pipeline)
    router.attach(pipeline)
    router.detach()
    pipeline.emit('friend-delete', { userId: 'usr_1' })
    expect(enqueue).not.toHaveBeenCalled()
    expect(otherListener).toHaveBeenCalledTimes(1)
  })

  it('attaching to another pipeline removes the listeners of the old pipeline', () => {
    const repository = new UserStateRepository(tempFilePath())
    const coordinator = new UserStateCoordinator(
      repository,
      () => Promise.resolve(),
      () => snapshot
    )
    const enqueue = jest
      .spyOn(coordinator, 'enqueue')
      .mockImplementation(() => undefined)
    const first = fakePipeline()
    const second = fakePipeline()
    const router = new PipelineEventRouter(coordinator)
    router.attach(first)
    router.attach(second)
    first.emit('friend-delete', { userId: 'usr_1' })
    second.emit('friend-delete', { userId: 'usr_2' })
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue).toHaveBeenCalledWith('usr_2', 'usr_2', {
      type: 'friend-delete',
    })
    router.detach()
  })
})
