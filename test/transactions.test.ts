import {
  createKeyspaceTx,
  createKeyspaceForOuTx,
  grantMachineTx,
  grantTx,
  revokeMachineTx,
  revokeTx,
  publishEntryTx,
  updateEntryTx,
  editEntryTx,
  editDescriptionTx,
} from '../src/transactions'
import type { Principal } from '../src/types'
import { AclClientError } from '../src/errors'

const PKG = '0xdeadbeef'
const ACL = '0x0000000000000000000000000000000000000000000000000000000000001001'
const OU = '0x0000000000000000000000000000000000000000000000000000000000001002'
const ENTRY =
  '0x0000000000000000000000000000000000000000000000000000000000001003'
const ADDR =
  '0x0000000000000000000000000000000000000000000000000000000000001004'

const playerPrincipal: Principal = { type: 'player', address: ADDR }
const ouPrincipal: Principal = {
  type: 'ou',
  ouId: '0x0000000000000000000000000000000000000000000000000000000000002001',
}
const machinePrincipal: Principal = { type: 'machine', address: ADDR }

describe('transaction builders', () => {
  it('createKeyspaceTx returns a transaction object', () => {
    const tx = createKeyspaceTx(PKG, 'my-keyspace')
    expect(tx).toBeTruthy()
    expect(typeof tx).toBe('object')
  })

  it('grantTx returns a transaction object for player principal', () => {
    const tx = grantTx(PKG, ACL, OU, 'Read', playerPrincipal)
    expect(tx).toBeTruthy()
    expect(typeof tx).toBe('object')
  })

  it('grantTx returns a transaction object for ou principal', () => {
    const tx = grantTx(PKG, ACL, OU, 'Grant', ouPrincipal)
    expect(tx).toBeTruthy()
    expect(typeof tx).toBe('object')
  })

  it('grantTx rejects machine principals — the on-chain enum is frozen', () => {
    expect(() => grantTx(PKG, ACL, OU, 'Read', machinePrincipal)).toThrow(
      AclClientError,
    )
  })

  it('revokeTx rejects machine principals', () => {
    expect(() => revokeTx(PKG, ACL, OU, 'Read', machinePrincipal)).toThrow(
      AclClientError,
    )
  })

  it('grantMachineTx returns a transaction object', () => {
    const tx = grantMachineTx(PKG, ACL, OU, 'Read', ADDR)
    expect(tx).toBeTruthy()
    expect(typeof tx).toBe('object')
  })

  it('revokeMachineTx returns a transaction object', () => {
    const tx = revokeMachineTx(PKG, ACL, OU, 'Read', ADDR)
    expect(tx).toBeTruthy()
    expect(typeof tx).toBe('object')
  })

  it('grantMachineTx works for all KeyspaceRole values', () => {
    for (const role of ['Grant', 'Read', 'Write'] as const) {
      const tx = grantMachineTx(PKG, ACL, OU, role, ADDR)
      expect(tx).toBeTruthy()
    }
  })

  it('grantTx works for all KeyspaceRole values', () => {
    for (const role of ['Grant', 'Read', 'Write'] as const) {
      const tx = grantTx(PKG, ACL, OU, role, playerPrincipal)
      expect(tx).toBeTruthy()
    }
  })

  it('revokeTx returns a transaction object', () => {
    const tx = revokeTx(PKG, ACL, OU, 'Write', playerPrincipal)
    expect(tx).toBeTruthy()
    expect(typeof tx).toBe('object')
  })

  it('publishEntryTx returns a transaction object', () => {
    const tx = publishEntryTx(PKG, ACL, OU, 'ipfs://Qmcid123', 'description')
    expect(tx).toBeTruthy()
    expect(typeof tx).toBe('object')
  })

  it('updateEntryTx returns a transaction object', () => {
    const tx = updateEntryTx(PKG, ACL, ENTRY, OU, 'ipfs://Qmnewcid')
    expect(tx).toBeTruthy()
    expect(typeof tx).toBe('object')
  })

  it('editEntryTx returns a transaction object', () => {
    const tx = editEntryTx(PKG, ACL, ENTRY, OU, 'ipfs://Qmeditcid')
    expect(tx).toBeTruthy()
    expect(typeof tx).toBe('object')
  })

  it('editDescriptionTx returns a transaction object', () => {
    const tx = editDescriptionTx(PKG, ACL, ENTRY, OU, 'new description')
    expect(tx).toBeTruthy()
    expect(typeof tx).toBe('object')
  })

  it('each builder returns a distinct transaction instance', () => {
    const tx1 = grantTx(PKG, ACL, OU, 'Read', playerPrincipal)
    const tx2 = grantTx(PKG, ACL, OU, 'Read', playerPrincipal)
    expect(tx1).not.toBe(tx2)
  })

  it('grantTx throws for an unknown role value', () => {
    expect(() =>
      grantTx(PKG, ACL, OU, 'Unknown' as any, playerPrincipal),
    ).toThrow('Unknown KeyspaceRole: Unknown')
  })
})

describe('createKeyspaceForOuTx', () => {
  it('returns a transaction object with player grant principals', () => {
    const tx = createKeyspaceForOuTx(
      PKG,
      OU,
      'Org ACL',
      [playerPrincipal],
      [],
      [],
    )
    expect(tx).toBeTruthy()
    expect(typeof tx).toBe('object')
  })

  it('returns a transaction object with ou principals across all roles', () => {
    const tx = createKeyspaceForOuTx(
      PKG,
      OU,
      'Org ACL',
      [ouPrincipal],
      [ouPrincipal],
      [ouPrincipal],
    )
    expect(tx).toBeTruthy()
    expect(typeof tx).toBe('object')
  })

  it('returns a transaction object when read and write lists are empty', () => {
    const tx = createKeyspaceForOuTx(
      PKG,
      OU,
      'Grant-only',
      [ouPrincipal],
      [],
      [],
    )
    expect(tx).toBeTruthy()
  })

  it('encodes mixed player and ou principals in the same list', () => {
    const tx = createKeyspaceForOuTx(
      PKG,
      OU,
      'Mixed',
      [playerPrincipal, ouPrincipal],
      [],
      [],
    )
    expect(tx).toBeTruthy()
  })

  it('rejects machine principals at keyspace creation — grant after create instead', () => {
    expect(() =>
      createKeyspaceForOuTx(
        PKG,
        OU,
        'Mixed',
        [ouPrincipal],
        [playerPrincipal, machinePrincipal],
        [],
      ),
    ).toThrow(AclClientError)
  })

  it('returns a distinct transaction instance per call', () => {
    const tx1 = createKeyspaceForOuTx(PKG, OU, 'A', [ouPrincipal], [], [])
    const tx2 = createKeyspaceForOuTx(PKG, OU, 'A', [ouPrincipal], [], [])
    expect(tx1).not.toBe(tx2)
  })
})
