import type { DiscordEmbed, DiscordEmbedField } from '@book000/node-utils'
import {
  parseLocation,
  type InstanceType,
  type ParsedInstance,
} from '../state/location'
import type {
  NotifiableEffect,
  ContextWorlds,
  ContextOwners,
} from '../rules/rule-context'
import type { WorldResolveResult } from '../vrchat/world-resolver'

/** Discord Embed character limits */
export const EMBED_LIMITS = { title: 256, fieldValue: 1024, footer: 2048 }

/** Title and color per event type (labels are user-facing Discord text) */
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

/** Display names for statuses (as written in VRChat) */
const STATUS_LABELS: Record<string, string> = {
  active: 'Online',
  'join me': 'Join Me',
  'ask me': 'Ask Me',
  busy: 'Do Not Disturb',
}

/** Display names for instance types (as written in VRChat) */
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
 * Truncates text to the limit, replacing the tail with an ellipsis
 *
 * @param text Target string
 * @param max Maximum length
 * @returns The truncated string
 */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Base URL of VRChat Web pages */
const VRCHAT_HOME = 'https://vrchat.com/home'

/**
 * Builds a Discord Markdown link
 *
 * @param text Link text (`[`, `]` and `\` are escaped)
 * @param url Link target URL
 * @returns Markdown link
 */
function link(text: string, url: string): string {
  return `[${text.replaceAll(/[[\\\]]/g, String.raw`\$&`)}](${url})`
}

/**
 * Resolves a VRChat Web page URL from a user or group ID
 *
 * @param id `usr_` or `grp_` ID
 * @returns Page URL
 */
function ownerUrl(id: string): string {
  return `${VRCHAT_HOME}/${id.startsWith('grp_') ? 'group' : 'user'}/${id}`
}

/**
 * Builds the instance owner display (falls back to the raw ID when the name is unresolved)
 *
 * @param instance Parsed instance
 * @param owner Owner name resolution result
 * @returns ` · 👤 name` (` · 👥 name` for groups; empty for public instances without an owner)
 */
function describeOwner(
  instance: ParsedInstance,
  owner: WorldResolveResult | undefined
): string {
  if (instance.ownerId === '') return ''
  const icon = instance.type.startsWith('group') ? '\u{1F465}' : '\u{1F464}'
  const name =
    owner?.name === undefined || owner.stale === true
      ? instance.ownerId
      : owner.name
  return ` · ${icon} ${link(name, ownerUrl(instance.ownerId))}`
}

/**
 * Formats a Location with its resolved world and owner for display
 *
 * @param location raw Location
 * @param world World resolution result
 * @param owner Instance owner name resolution result
 * @returns Display string
 */
function describeLocation(
  location: string | null,
  world: WorldResolveResult | undefined,
  owner: WorldResolveResult | undefined
): string {
  const parsed = parseLocation(location)
  if (!parsed.visible) return location === 'private' ? 'Private' : '不明'
  const instanceId = location?.slice(location.indexOf(':') + 1)
  const launchUrl = `${VRCHAT_HOME}/launch?worldId=${parsed.worldId}${
    location?.includes(':')
      ? `&instanceId=${encodeURIComponent(instanceId ?? '')
          .replaceAll('(', '%28')
          .replaceAll(')', '%29')}`
      : ''
  }`
  const instance = link(
    `${INSTANCE_TYPE_LABELS[parsed.instance.type]}${parsed.instance.name ? ` #${parsed.instance.name}` : ''}`,
    launchUrl
  )
  const ownerText = describeOwner(parsed.instance, owner)
  if (world?.name !== undefined && world.stale !== true) {
    return `${link(world.name, `${VRCHAT_HOME}/world/${parsed.worldId}`)} · ${instance}${ownerText}`
  }
  const last = world?.lastFetchedAt ? `\n最終取得: ${world.lastFetchedAt}` : ''
  return `取得失敗 (${parsed.worldId}) · ${instance}${ownerText}${last}`
}

/**
 * Formats a before/after pair as `before → after` (empty strings are shown as "なし")
 *
 * @param previous Value before the change
 * @param current Value after the change
 * @returns Display string
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
 * Builds the Discord Embed for a notification
 *
 * @param effect Effect to notify about
 * @param worlds World resolution results
 * @param ruleNames Matched rule names (in config order)
 * @param now Timestamp (ISO 8601)
 * @param owners Instance owner name resolution results
 * @returns Discord Embed
 */
export function buildEmbed(
  effect: NotifiableEffect,
  worlds: ContextWorlds,
  ruleNames: readonly string[],
  now: string = new Date().toISOString(),
  owners: ContextOwners = {}
): DiscordEmbed {
  const style = STYLES[effect.type]
  const subject = effect.current ?? effect.previous
  const name = subject?.displayName ?? ''
  const userId = subject?.userId
  const fields: DiscordEmbedField[] = [
    {
      name: 'ユーザー',
      value: userId === undefined ? name : link(name, ownerUrl(userId)),
      inline: true,
    },
  ]
  switch (effect.type) {
    case 'location-change': {
      fields.push(
        {
          name: '前の場所',
          value: describeLocation(
            effect.previous?.location ?? null,
            worlds.previous,
            owners.previous
          ),
        },
        {
          name: '現在の場所',
          value: describeLocation(
            effect.current?.location ?? null,
            worlds.current,
            owners.current
          ),
        }
      )

      break
    }
    case 'status-change': {
      const previous = effect.previous
      const current = effect.current
      // Omitted when the previous status is unknown, since "なし → X" would be misleading
      if (
        previous?.status !== undefined &&
        previous.status !== current?.status
      ) {
        fields.push({
          name: 'ステータス',
          value: describeChange(
            STATUS_LABELS[previous.status] ?? previous.status,
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
          worlds.current,
          owners.current
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
