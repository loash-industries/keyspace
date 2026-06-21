import {
  createKeyspaceTx,
  createKeyspaceForDaoTx,
  grantTx,
  revokeTx,
  publishEntryTx,
  updateEntryTx,
  editEntryTx,
  editDescriptionTx,
} from '../src/transactions'
import type { Principal } from '../src/types'

const PKG = '0xdeadbeef'
const ACL = '0x0000000000000000000000000000000000000000000000000000000000001001'
const DAO = '0x0000000000000000000000000000000000000000000000000000000000001002'
const ENTRY =
  '0x0000000000000000000000000000000000000000000000000000000000001003'
const ADDR =
  '0x0000000000000000000000000000000000000000000000000000000000001004'

const playerPrincipal: Principal = { type: 'player', address: ADDR }
const ouPrincipal: Principal = {
  type: 'ou',
  daoId: '0x0000000000000000000000000000000000000000000000000000000000002001',
}

describe('transaction builders', () => {
  it('createKeyspaceTx returns a transaction object', () => {
    const tx = createKeyspaceTx(PKG, 'my-keyspace')
    expect(tx).toBeTruthy()
    expect(typeof tx).toBe('object')
  })

  it('grantTx returns a transaction object for player principal', () => {
    const tx = grantTx(PKG, ACL, DAO, 'Read', playerPrincipal)
    expect(tx).toBeTruthy()
    expect(typeof tx).toBe('object')
  })

  it('grantTx returns a transaction object for ou principal', () => {
    const tx = grantTx(PKG, ACL, DAO, 'Grant', ouPrincipal)
    expect(tx).toBeTruthy()
    expect(typeof tx).toBe('object')
  })

  it('grantTx works for all KeyspaceRole values', () => {
    for (const role of ['Grant', 'Read', 'Write'] as const) {
      const tx = grantTx(PKG, ACL, DAO, role, playerPrincipal)
      expect(tx).toBeTruthy()
    }
  })

  it('revokeTx returns a transaction object', () => {
    const tx = revokeTx(PKG, ACL, DAO, 'Write', playerPrincipal)
    expect(tx).toBeTruthy()
    expect(typeof tx).toBe('object')
  })

  it('publishEntryTx returns a transaction object', () => {
    const tx = publishEntryTx(PKG, ACL, DAO, 'ipfs://Qmcid123', 'description')
    expect(tx).toBeTruthy()
    expect(typeof tx).toBe('object')
  })

  it('updateEntryTx returns a transaction object', () => {
    const tx = updateEntryTx(PKG, ACL, ENTRY, DAO, 'ipfs://Qmnewcid')
    expect(tx).toBeTruthy()
    expect(typeof tx).toBe('object')
  })

  it('editEntryTx returns a transaction object', () => {
    const tx = editEntryTx(PKG, ACL, ENTRY, DAO, 'ipfs://Qmeditcid')
    expect(tx).toBeTruthy()
    expect(typeof tx).toBe('object')
  })

  it('editDescriptionTx returns a transaction object', () => {
    const tx = editDescriptionTx(PKG, ACL, ENTRY, DAO, 'new description')
    expect(tx).toBeTruthy()
    expect(typeof tx).toBe('object')
  })

  it('each builder returns a distinct transaction instance', () => {
    const tx1 = grantTx(PKG, ACL, DAO, 'Read', playerPrincipal)
    const tx2 = grantTx(PKG, ACL, DAO, 'Read', playerPrincipal)
    expect(tx1).not.toBe(tx2)
  })

  it('grantTx throws for an unknown role value', () => {
    expect(() =>
      grantTx(PKG, ACL, DAO, 'Unknown' as any, playerPrincipal),
    ).toThrow('Unknown KeyspaceRole: Unknown')
  })
})

describe('createKeyspaceForDaoTx', () => {
  it('returns a transaction object with player grant principals', () => {
    const tx = createKeyspaceForDaoTx(
      PKG,
      DAO,
      'Org ACL',
      [playerPrincipal],
      [],
      [],
    )
    expect(tx).toBeTruthy()
    expect(typeof tx).toBe('object')
  })

  it('returns a transaction object with ou principals across all roles', () => {
    const tx = createKeyspaceForDaoTx(
      PKG,
      DAO,
      'Org ACL',
      [ouPrincipal],
      [ouPrincipal],
      [ouPrincipal],
    )
    expect(tx).toBeTruthy()
    expect(typeof tx).toBe('object')
  })

  it('returns a transaction object when read and write lists are empty', () => {
    const tx = createKeyspaceForDaoTx(
      PKG,
      DAO,
      'Grant-only',
      [ouPrincipal],
      [],
      [],
    )
    expect(tx).toBeTruthy()
  })

  it('encodes mixed player and ou principals in the same list', () => {
    const tx = createKeyspaceForDaoTx(
      PKG,
      DAO,
      'Mixed',
      [playerPrincipal, ouPrincipal],
      [],
      [],
    )
    expect(tx).toBeTruthy()
  })

  it('returns a distinct transaction instance per call', () => {
    const tx1 = createKeyspaceForDaoTx(PKG, DAO, 'A', [ouPrincipal], [], [])
    const tx2 = createKeyspaceForDaoTx(PKG, DAO, 'A', [ouPrincipal], [], [])
    expect(tx1).not.toBe(tx2)
  })
})
