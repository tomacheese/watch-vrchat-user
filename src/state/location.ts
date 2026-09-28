/** インスタンス種別 */
export type InstanceType =
  | 'public'
  | 'friends-plus'
  | 'friends'
  | 'invite'
  | 'invite-plus'
  | 'group-public'
  | 'group-plus'
  | 'group-members'

/** パース済みインスタンス情報 */
export interface ParsedInstance {
  /** インスタンス名（`:` の後から最初の `~` まで） */
  name: string
  /** インスタンス種別 */
  type: InstanceType
  /** オーナーのユーザー ID またはグループ ID（public は空文字） */
  ownerId: string
  /** リージョン（指定が無い場合は `us`） */
  region: string
  /** 年齢制限の有無 */
  ageGate: boolean
}

/**
 * パース済み Location
 *
 * raw 文字列と nonce は意図的に含めない（CEL へ公開しないため）。
 */
export type ParsedLocation =
  | { visible: false }
  | { visible: true; worldId: string; instance: ParsedInstance }

/**
 * Location が transient な traveling 値かを判定する
 *
 * @param raw raw Location
 * @returns `traveling` で始まる場合は true
 */
export function isTraveling(raw: string | null): boolean {
  return raw?.startsWith('traveling') ?? false
}

/**
 * `name(arg)` 形式のタグを分解する
 *
 * @param tag タグ文字列
 * @returns タグ名と引数（引数なしは空文字）
 */
function parseTag(tag: string): { key: string; arg: string } {
  const open = tag.indexOf('(')
  const close = tag.lastIndexOf(')')
  return open === -1 || close < open
    ? { key: tag, arg: '' }
    : { key: tag.slice(0, open), arg: tag.slice(open + 1, close) }
}

/**
 * インスタンス種別を判定する
 *
 * @param tags タグ名から引数へのマップ
 * @returns インスタンス種別
 */
function resolveType(tags: Map<string, string>): InstanceType {
  if (tags.has('group')) {
    const access = tags.get('groupAccessType')
    if (access === 'public') return 'group-public'
    return access === 'plus' ? 'group-plus' : 'group-members'
  }
  if (tags.has('hidden')) return 'friends-plus'
  if (tags.has('friends')) return 'friends'
  if (tags.has('private')) {
    return tags.has('canRequestInvite') ? 'invite-plus' : 'invite'
  }
  return 'public'
}

/**
 * raw Location を CEL 公開用の構造へパースする純粋関数
 *
 * `wrld_` で始まらない値（`private` / `offline` / `traveling*` / 不正値 / null）は不可視として扱う。
 *
 * @param raw raw Location
 * @returns パース結果
 */
export function parseLocation(raw: string | null): ParsedLocation {
  if (!raw?.startsWith('wrld_')) {
    return { visible: false }
  }
  const colon = raw.indexOf(':')
  if (colon === -1) {
    return {
      visible: true,
      worldId: raw,
      instance: {
        name: '',
        type: 'public',
        ownerId: '',
        region: 'us',
        ageGate: false,
      },
    }
  }
  const [name, ...tagStrings] = raw.slice(colon + 1).split('~')
  const tags = new Map<string, string>()
  for (const tagString of tagStrings) {
    const { key, arg } = parseTag(tagString)
    tags.set(key, arg)
  }
  const ownerId =
    tags.get('group') ??
    tags.get('hidden') ??
    tags.get('friends') ??
    tags.get('private') ??
    ''
  return {
    visible: true,
    worldId: raw.slice(0, colon),
    instance: {
      name,
      type: resolveType(tags),
      ownerId,
      region: tags.get('region') ?? 'us',
      ageGate: tags.has('ageGate'),
    },
  }
}
