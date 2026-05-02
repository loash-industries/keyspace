import { AclError, AclClientError } from '../src/errors';
import {
  createAllowlistTx,
  addMemberTx,
  removeMemberTx,
  publishEntryTx,
  updateEntryTx,
  editEntryTx,
  transferAdminCapTx,
  roleToAddress,
} from '../src/transactions';

const PKG = '0xdeadbeef';
// Sui addresses must be exactly 32 bytes (64 hex chars after 0x)
const ACL   = '0x0000000000000000000000000000000000000000000000000000000000001001';
const CAP   = '0x0000000000000000000000000000000000000000000000000000000000001002';
const ENTRY = '0x0000000000000000000000000000000000000000000000000000000000001003';
const ADDR  = '0x0000000000000000000000000000000000000000000000000000000000001004';

describe('roleToAddress', () => {
  it('returns the address for an address-type role', () => {
    expect(roleToAddress({ type: 'address', address: ADDR })).toBe(ADDR);
  });

  it('throws AclClientError(NotImplemented) for tribe roles', () => {
    expect(() => roleToAddress({ type: 'tribe', tribeId: '0xtribe' })).toThrow(AclClientError);
    expect(() => roleToAddress({ type: 'tribe', tribeId: '0xtribe' })).toThrow(
      /tribe/i,
    );
    try {
      roleToAddress({ type: 'tribe', tribeId: '0xtribe' });
    } catch (e) {
      expect((e as AclClientError).code).toBe(AclError.NotImplemented);
    }
  });
});

describe('transaction builders', () => {
  it('createAllowlistTx returns a transaction object', () => {
    const tx = createAllowlistTx(PKG, 'my-acl');
    expect(tx).toBeTruthy();
    expect(typeof tx).toBe('object');
  });

  it('addMemberTx returns a transaction object', () => {
    const tx = addMemberTx(PKG, ACL, CAP, ADDR);
    expect(tx).toBeTruthy();
    expect(typeof tx).toBe('object');
  });

  it('removeMemberTx returns a transaction object', () => {
    const tx = removeMemberTx(PKG, ACL, CAP, ADDR);
    expect(tx).toBeTruthy();
    expect(typeof tx).toBe('object');
  });

  it('publishEntryTx returns a transaction object', () => {
    const tx = publishEntryTx(PKG, ACL, 'ipfs://Qmcid123', 'description');
    expect(tx).toBeTruthy();
    expect(typeof tx).toBe('object');
  });

  it('updateEntryTx returns a transaction object', () => {
    const tx = updateEntryTx(PKG, ACL, ENTRY, 'ipfs://Qmnewcid');
    expect(tx).toBeTruthy();
    expect(typeof tx).toBe('object');
  });

  it('editEntryTx returns a transaction object', () => {
    const tx = editEntryTx(PKG, ACL, ENTRY, 'ipfs://Qmeditcid');
    expect(tx).toBeTruthy();
    expect(typeof tx).toBe('object');
  });

  it('transferAdminCapTx returns a transaction object', () => {
    const tx = transferAdminCapTx(CAP, ADDR);
    expect(tx).toBeTruthy();
    expect(typeof tx).toBe('object');
  });

  it('each builder returns a distinct transaction instance', () => {
    const tx1 = addMemberTx(PKG, ACL, CAP, ADDR);
    const tx2 = addMemberTx(PKG, ACL, CAP, ADDR);
    expect(tx1).not.toBe(tx2);
  });
});
