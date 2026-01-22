/**
 * VRChat クライアントを管理するモジュール
 */

import * as readline from 'node:readline'
import { KeyvFile } from 'keyv-file'
import { VRChat } from 'vrchat'
import type { Config } from './config'

/** Cookie ファイルのパス */
const COOKIE_FILE_PATH = 'data/vrchat-cookies.json'

/**
 * readline を使って 2FA コードを入力させる
 *
 * @returns ユーザーが入力した 2FA コード
 */
async function promptTwoFactorCode(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question('Enter 2FA code: ', (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

/**
 * Cookie データの型定義
 */
interface CookieData {
  value: { name: string; value: string }[]
}

/**
 * WebSocket (pipeline) を認証する
 *
 * @param vrchat VRChat クライアント
 * @param keyvAdapter Cookie を保存している Keyv アダプタ
 */
async function authenticateWebSocket(
  vrchat: VRChat,
  keyvAdapter: KeyvFile
): Promise<void> {
  const cookiesData = await keyvAdapter.get('keyv:cookies')
  if (!cookiesData) {
    console.warn('[VRCHAT] No cookies data found, WebSocket not authenticated')
    return
  }

  let parsed: CookieData
  try {
    parsed = JSON.parse(cookiesData as string) as CookieData
  } catch {
    console.error(
      '[VRCHAT] Failed to parse cookies data, WebSocket not authenticated'
    )
    return
  }

  const authCookie = parsed.value.find((c) => c.name === 'auth')
  if (!authCookie) {
    console.warn('[VRCHAT] Auth cookie not found, WebSocket not authenticated')
    return
  }

  await vrchat.pipeline.authenticate(authCookie.value)
  console.log('[VRCHAT] WebSocket authenticated')
}

/**
 * VRChat クライアントを初期化する
 *
 * @param config アプリケーション設定
 * @returns 初期化された VRChat クライアント
 */
export async function createVRChatClient(config: Config): Promise<VRChat> {
  console.log('[VRCHAT] Initializing VRChat client...')

  // Cookie 永続化用の Keyv アダプタを作成
  const keyvAdapter = new KeyvFile({
    filename: COOKIE_FILE_PATH,
    writeDelay: 100,
  })

  // VRChat クライアントを初期化
  const vrchat = new VRChat({
    baseUrl: 'https://api.vrchat.cloud/api/1',
    application: {
      name: 'watch-vrchat-user',
      version: '1.0.0',
      contact: 'tomachi@tomacheese.com',
    },
    keyv: keyvAdapter,
  })

  // まず Cookie を使ってセッション復元を試みる
  console.log('[VRCHAT] Checking existing session...')
  const currentUserResult = await vrchat.getCurrentUser()

  // セッションが有効な場合（displayName がある = CurrentUser）
  if (currentUserResult.data && 'displayName' in currentUserResult.data) {
    console.log(
      `[VRCHAT] Session restored: ${currentUserResult.data.displayName}`
    )

    // WebSocket (pipeline) を認証するために keyv から auth cookie を取得
    await authenticateWebSocket(vrchat, keyvAdapter)

    return vrchat
  }

  // セッションが無効な場合はログインを試みる
  console.log('[VRCHAT] No valid session, logging in...')
  const loginResult = await vrchat.login({
    username: config.vrchat.username,
    password: config.vrchat.password,
    totpSecret: config.vrchat.totpSecret,
    // totpSecret が設定されていない場合は readline で 2FA コードを入力させる
    twoFactorCode: config.vrchat.totpSecret ? undefined : promptTwoFactorCode,
  })

  if (loginResult.error) {
    throw new Error(`Failed to login: ${loginResult.error.message}`)
  }

  // loginResult.data は CurrentUser | RequiresTwoFactorAuth の可能性があるため、
  // displayName プロパティの存在を確認
  const data = loginResult.data
  const displayName = 'displayName' in data ? data.displayName : 'Unknown'
  console.log(`[VRCHAT] Logged in as ${displayName}`)

  // ログイン後も WebSocket を認証する
  await authenticateWebSocket(vrchat, keyvAdapter)

  return vrchat
}

/**
 * 指定したユーザー ID がフレンドかどうかを確認する
 *
 * @param vrchat VRChat クライアント
 * @param userId 確認するユーザー ID
 * @returns フレンドの場合は true
 */
export async function isFriend(
  vrchat: VRChat,
  userId: string
): Promise<boolean> {
  const result = await vrchat.getFriendStatus({ path: { userId } })
  return result.data?.isFriend ?? false
}

/**
 * ユーザー情報の型定義
 */
export interface UserInfo {
  /** ユーザー ID */
  id: string
  /** 表示名 */
  displayName: string
  /** 現在の Location（offline の場合は null） */
  location: string | null
  /** ステータス */
  status: string
  /** 現在いるワールドの情報 */
  world?: {
    id: string
    name: string
    thumbnailImageUrl?: string
  }
}

/**
 * ユーザー情報を取得する
 *
 * @param vrchat VRChat クライアント
 * @param userId ユーザー ID
 * @returns ユーザー情報（取得できない場合は null）
 */
export async function getUser(
  vrchat: VRChat,
  userId: string
): Promise<UserInfo | null> {
  const result = await vrchat.getUser({ path: { userId } })

  if (!result.data) {
    return null
  }

  const user = result.data

  // Location が "offline" または空の場合は null として扱う
  const location =
    user.location && user.location !== 'offline' ? user.location : null

  return {
    id: user.id,
    displayName: user.displayName,
    location,
    status: user.status,
  }
}

/**
 * フレンド一覧を取得する
 *
 * @param vrchat VRChat クライアント
 * @returns フレンドのユーザー ID の配列
 */
export async function getFriendIds(vrchat: VRChat): Promise<string[]> {
  const friendIds: string[] = []
  let offset = 0
  const limit = 100

  // ページネーションを使ってすべてのフレンドを取得
  while (true) {
    const result = await vrchat.getFriends({
      query: { n: limit, offset },
    })

    if (!result.data) {
      break
    }

    for (const friend of result.data) {
      friendIds.push(friend.id)
    }

    // すべて取得した場合はループを抜ける
    if (result.data.length < limit) {
      break
    }

    offset += limit
  }

  return friendIds
}
