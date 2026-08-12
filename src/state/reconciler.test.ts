import { Reconciler } from './reconciler'
import { UserStateCoordinator } from './user-state-coordinator'
import { UserStateRepository } from './user-state-repository'
import * as session from '../vrchat/session'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { VRChat } from 'vrchat'

jest.mock('../vrchat/session')

function tempFilePath(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'reconciler-')),
    'user-locations.json'
  )
}

describe('Reconciler.reconcileAll', () => {
  it('REST snapshot を observation として compare-and-enqueue する', async () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    const coordinator = new UserStateCoordinator(repository, async () => {})
    const appendSpy = jest.spyOn(coordinator, 'appendSnapshotObservation')
    ;(session.getUser as jest.Mock).mockResolvedValue({
      id: 'usr_1',
      displayName: 'Alice',
      location: 'wrld_a',
      status: 'active',
    })

    const reconciler = new Reconciler(
      () => ({}) as VRChat,
      coordinator,
      ['usr_1']
    )
    await reconciler.reconcileAll()

    expect(appendSpy).toHaveBeenCalledWith(
      'usr_1',
      'Alice',
      { type: 'location', location: 'wrld_a' },
      0
    )
    expect(reconciler.getLastRunAt()).not.toBeNull()
  })

  it('location が null の場合は offline observation を追記する', async () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    const coordinator = new UserStateCoordinator(repository, async () => {})
    const appendSpy = jest.spyOn(coordinator, 'appendSnapshotObservation')
    ;(session.getUser as jest.Mock).mockResolvedValue({
      id: 'usr_1',
      displayName: 'Alice',
      location: null,
      status: 'offline',
    })

    const reconciler = new Reconciler(
      () => ({}) as VRChat,
      coordinator,
      ['usr_1']
    )
    await reconciler.reconcileAll()

    expect(appendSpy).toHaveBeenCalledWith('usr_1', 'Alice', { type: 'offline' }, 0)
  })

  it('429 エラーが発生した場合は残りのユーザーの reconcile を中断する', async () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    const coordinator = new UserStateCoordinator(repository, async () => {})
    const appendSpy = jest.spyOn(coordinator, 'appendSnapshotObservation')
    ;(session.getUser as jest.Mock).mockRejectedValue(
      new Error('Rate limit error (429): too many requests')
    )

    const reconciler = new Reconciler(
      () => ({}) as VRChat,
      coordinator,
      ['usr_1', 'usr_2']
    )
    await reconciler.reconcileAll()

    expect(appendSpy).not.toHaveBeenCalled()
  })

  it('vrchat が未接続の場合は何もしない', async () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    const coordinator = new UserStateCoordinator(repository, async () => {})
    const appendSpy = jest.spyOn(coordinator, 'appendSnapshotObservation')

    const reconciler = new Reconciler(() => null, coordinator, ['usr_1'])
    await reconciler.reconcileAll()

    expect(appendSpy).not.toHaveBeenCalled()
  })
})
