import { isTraveling, parseLocation } from './location'

function instance(raw: string) {
  const parsed = parseLocation(raw)
  if (!parsed.visible) throw new Error('expected visible')
  return parsed.instance
}

describe('parseLocation', () => {
  it('public', () => {
    expect(parseLocation('wrld_a:12345')).toEqual({
      visible: true,
      worldId: 'wrld_a',
      instance: {
        name: '12345',
        type: 'public',
        ownerId: '',
        region: 'us',
        ageGate: false,
      },
    })
  })

  it('hidden は friends-plus', () => {
    expect(instance('wrld_a:1~hidden(usr_x)~region(jp)~nonce(abc)')).toEqual({
      name: '1',
      type: 'friends-plus',
      ownerId: 'usr_x',
      region: 'jp',
      ageGate: false,
    })
  })

  it('friends', () => {
    expect(instance('wrld_a:1~friends(usr_x)~region(eu)')).toMatchObject({
      type: 'friends',
      ownerId: 'usr_x',
      region: 'eu',
    })
  })

  it('private は invite、canRequestInvite 付きは invite-plus', () => {
    expect(instance('wrld_a:1~private(usr_x)')).toMatchObject({
      type: 'invite',
      ownerId: 'usr_x',
    })
    expect(instance('wrld_a:1~private(usr_x)~canRequestInvite')).toMatchObject({
      type: 'invite-plus',
    })
  })

  it('group の各 accessType', () => {
    expect(
      instance('wrld_a:1~group(grp_x)~groupAccessType(public)')
    ).toMatchObject({ type: 'group-public', ownerId: 'grp_x' })
    expect(
      instance('wrld_a:1~group(grp_x)~groupAccessType(plus)')
    ).toMatchObject({ type: 'group-plus' })
    expect(
      instance('wrld_a:1~group(grp_x)~groupAccessType(members)')
    ).toMatchObject({ type: 'group-members' })
  })

  it('ageGate', () => {
    expect(instance('wrld_a:1~ageGate')).toMatchObject({ ageGate: true })
  })

  it('不可視な値', () => {
    for (const raw of [
      'private',
      'offline',
      'traveling:traveling',
      'garbage',
    ]) {
      expect(parseLocation(raw)).toEqual({ visible: false })
    }
    expect(parseLocation(null)).toEqual({ visible: false })
  })

  it('raw と nonce を含まない', () => {
    const json = JSON.stringify(
      parseLocation('wrld_a:1~hidden(usr_x)~nonce(secret)')
    )
    expect(json).not.toContain('secret')
    expect(json).not.toContain('nonce')
  })
})

describe('isTraveling', () => {
  it('traveling で始まる値のみ true', () => {
    expect(isTraveling('traveling')).toBe(true)
    expect(isTraveling('traveling:traveling')).toBe(true)
    expect(isTraveling('wrld_a:1')).toBe(false)
    expect(isTraveling(null)).toBe(false)
  })
})
