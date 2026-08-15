import { KeyspaceRole } from '../src/types'
import { KeyspaceRole as KeyspaceRoleFromIndex } from '../src/index'
import { grantTx } from '../src/transactions'

const PKG = '0x2'
const ACL = '0x3'
const OU = '0x4'
const playerPrincipal = {
  type: 'player' as const,
  address: `0x${'ab'.repeat(32)}`,
}

describe('KeyspaceRole', () => {
  it('exposes the three roles as a runtime object', () => {
    expect(KeyspaceRole.Grant).toBe('Grant')
    expect(KeyspaceRole.Read).toBe('Read')
    expect(KeyspaceRole.Write).toBe('Write')
  })

  it('has exactly the three role values', () => {
    expect(Object.values(KeyspaceRole).sort()).toEqual([
      'Grant',
      'Read',
      'Write',
    ])
  })

  it('is re-exported as a value from the package entrypoint', () => {
    expect(KeyspaceRoleFromIndex).toBe(KeyspaceRole)
  })

  it('the runtime const is accepted wherever a role string is', () => {
    // KeyspaceRole.Read must be interchangeable with the bare 'Read' literal.
    const viaConst = grantTx(PKG, ACL, OU, KeyspaceRole.Read, playerPrincipal)
    const viaString = grantTx(PKG, ACL, OU, 'Read', playerPrincipal)
    expect(viaConst).toBeTruthy()
    expect(viaString).toBeTruthy()
  })
})
