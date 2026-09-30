import type { DiscordEmbed, DiscordEmbedField } from '@book000/node-utils'
import { parseLocation, type InstanceType } from '../state/location'
import type { NotifiableEffect, ContextWorlds } from '../rules/rule-context'
import type { WorldResolveResult } from '../vrchat/world-resolver'

/** Discord Embed の文字数上限 */
export const EMBED_LIMITS = { title: 256, fieldValue: 1024, footer: 2048 }

/** event 種別ごとの見出しと色 */
const STYLES: Record<
  NotifiableEffect['type'],
  { emoji: string; label: string; color: number }
> = {
  'location-change': {
    emoji: '\u{1F4CD}',
    label: 'ロケーション変更',
    color: 0x00_aa_ff,
  },
  online: { emoji: '\u{1F7E2}', label: 'オンライン', color: 0x00_ff_00 },
  offline: { emoji: '\u{26AB}', label: 'オフライン', color: 0x80_80_80 },
  'friend-add': { emoji: '\u{2795}', label: 'フレンド追加', color: 0xff_aa_00 },
  'friend-delete': {
    emoji: '\u{2796}',
    label: 'フレンド削除',
    color: 0xff_44_44,
  },
  'status-change': {
    emoji: '\u{1F4AC}',
    label: 'ステータス変更',
    color: 0xaa_55_ff,
  },
}

/** ステータスの表示名 (VRChat 上の表記) */
const STATUS_LABELS: Record<string, string> = {
  active: 'Online',
  'join me': 'Join Me',
  'ask me': 'Ask Me',
  busy: 'Do Not Disturb',
}

/** インスタンス種別の表示名 (VRChat 上の表記) */
const INSTANCE_TYPE_LABELS: Record<InstanceType, string> = {
  public: 'Public',
  'friends-plus': 'Friends+',
  friends: 'Friends',
  invite: 'Invite',
  'invite-plus': 'Invite+',
  'group-public': 'Group Public',
  'group-plus': 'Group+',
  'group-members': 'Group',
}

/**
 * 文字数上限を超える場合に末尾を省略記号へ置き換える
 *
 * @param text 対象文字列
 * @param max 上限文字数
 * @returns 切り詰め後の文字列
 */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * Location とワールド解決結果を表示用文字列にする
 *
 * @param location raw Location
 * @param world ワールド解決結果
 * @returns 表示用文字列
 */
function describeLocation(
  location: string | null,
  world: WorldResolveResult | undefined
): string {
  const parsed = parseLocation(location)
  if (!parsed.visible) return location === 'private' ? 'Private' : '不明'
  const instance = `${INSTANCE_TYPE_LABELS[parsed.instance.type]}${parsed.instance.name ? ` #${parsed.instance.name}` : ''}`
  if (world?.name !== undefined && world.stale !== true) {
    return `${world.name} (${instance})`
  }
  const last = world?.lastFetchedAt ? `\n最終取得: ${world.lastFetchedAt}` : ''
  return `取得失敗 (${parsed.worldId}, ${instance})${last}`
}

/**
 * 変更前後の値を `前 → 後` 形式にする（空文字は「なし」と表示する）
 *
 * @param previous 変更前の値
 * @param current 変更後の値
 * @returns 表示用文字列
 */
function describeChange(
  previous: string | undefined,
  current: string | undefined
): string {
  const show = (value: string | undefined): string =>
    value === undefined || value === '' ? 'なし' : value
  return `${show(previous)} → ${show(current)}`
}

/**
 * 通知用の Discord Embed を組み立てる
 *
 * @param effect 通知対象の effect
 * @param worlds ワールド解決結果
 * @param ruleNames 一致したルール名（設定順）
 * @param now タイムスタンプ (ISO 8601)
 * @returns Discord Embed
 */
export function buildEmbed(
  effect: NotifiableEffect,
  worlds: ContextWorlds,
  ruleNames: readonly string[],
  now: string = new Date().toISOString()
): DiscordEmbed {
  const style = STYLES[effect.type]
  const name = (effect.current ?? effect.previous)?.displayName ?? ''
  const fields: DiscordEmbedField[] = [
    { name: 'ユーザー', value: name, inline: true },
  ]
  switch (effect.type) {
    case 'location-change': {
      fields.push(
        {
          name: '前の場所',
          value: describeLocation(
            effect.previous?.location ?? null,
            worlds.previous
          ),
        },
        {
          name: '現在の場所',
          value: describeLocation(
            effect.current?.location ?? null,
            worlds.current
          ),
        }
      )

      break
    }
    case 'status-change': {
      const previous = effect.previous
      const current = effect.current
      if (previous?.status !== current?.status) {
        fields.push({
          name: 'ステータス',
          value: describeChange(
            STATUS_LABELS[previous?.status ?? ''] ?? previous?.status,
            STATUS_LABELS[current?.status ?? ''] ?? current?.status
          ),
        })
      }
      if (previous?.statusDescription !== current?.statusDescription) {
        fields.push({
          name: 'ステータスメッセージ',
          value: describeChange(
            previous?.statusDescription,
            current?.statusDescription
          ),
        })
      }

      break
    }
    case 'online': {
      fields.push({
        name: '現在の場所',
        value: describeLocation(
          effect.current?.location ?? null,
          worlds.current
        ),
      })

      break
    }
    // No default
  }
  return {
    title: truncate(
      `${style.emoji} ${name} ${style.label}`,
      EMBED_LIMITS.title
    ),
    color: style.color,
    fields: fields.map((f) => ({
      ...f,
      value: truncate(f.value || '-', EMBED_LIMITS.fieldValue),
    })),
    footer: {
      text: truncate(
        `検知ルール: ${ruleNames.join(', ')}`,
        EMBED_LIMITS.footer
      ),
    },
    timestamp: now,
  }
}
