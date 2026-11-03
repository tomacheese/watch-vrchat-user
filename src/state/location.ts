/** Instance type */
export type InstanceType =
  | 'public'
  | 'friends-plus'
  | 'friends'
  | 'invite'
  | 'invite-plus'
  | 'group-public'
  | 'group-plus'
  | 'group-members'

/** Parsed instance information */
export interface ParsedInstance {
  /** Instance name (from after `:` up to the first `~`) */
  name: string
  /** Instance type */
  type: InstanceType
  /** Owner user ID or group ID (empty string for public) */
  ownerId: string
  /** Region (`us` when not specified) */
  region: string
  /** Whether the instance is age-gated */
  ageGate: boolean
}

/**
 * Parsed Location
 *
 * The raw string and nonce are intentionally omitted so they are not exposed to CEL.
 */
export type ParsedLocation =
  | { visible: false }
  | { visible: true; worldId: string; instance: ParsedInstance }

/**
 * Determines whether a Location is the transient `traveling` value
 *
 * @param raw raw Location
 * @returns true if it starts with `traveling`
 */
export function isTraveling(raw: string | null): boolean {
  return raw?.startsWith('traveling') ?? false
}

/**
 * Splits a tag of the form `name(arg)`
 *
 * @param tag Tag string
 * @returns Tag name and argument (empty string when there is no argument)
 */
function parseTag(tag: string): { key: string; arg: string } {
  const open = tag.indexOf('(')
  const close = tag.lastIndexOf(')')
  return open === -1 || close < open
    ? { key: tag, arg: '' }
    : { key: tag.slice(0, open), arg: tag.slice(open + 1, close) }
}

/**
 * Determines the instance type
 *
 * @param tags Map from tag name to argument
 * @returns Instance type
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
 * Pure function that parses a raw Location into the structure exposed to CEL
 *
 * Values not starting with `wrld_` (`private` / `offline` / `traveling*` / invalid values / null) are treated as not visible.
 *
 * @param raw raw Location
 * @returns Parse result
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
