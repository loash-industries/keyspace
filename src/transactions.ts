import { Transaction } from '@mysten/sui/transactions'
import type { Role } from './types'
import { AclClientError, AclError } from './errors'

function textBytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s))
}

export function createAllowlistTx(
  packageId: string,
  name: string,
): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::acl_encrypt::create_allowlist`,
    arguments: [tx.pure.vector('u8', textBytes(name))],
  })
  return tx
}

export function addMemberTx(
  packageId: string,
  allowlistId: string,
  capId: string,
  grantee: string,
): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::acl_encrypt::add`,
    arguments: [
      tx.object(allowlistId),
      tx.object(capId),
      tx.pure.address(grantee),
    ],
  })
  return tx
}

export function removeMemberTx(
  packageId: string,
  allowlistId: string,
  capId: string,
  grantee: string,
): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::acl_encrypt::remove`,
    arguments: [
      tx.object(allowlistId),
      tx.object(capId),
      tx.pure.address(grantee),
    ],
  })
  return tx
}

export function publishEntryTx(
  packageId: string,
  allowlistId: string,
  location: string,
  description: string,
): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::acl_encrypt::publish_entry`,
    arguments: [
      tx.object(allowlistId),
      tx.pure.vector('u8', textBytes(location)),
      tx.pure.vector('u8', textBytes(description)),
    ],
  })
  return tx
}

export function updateEntryTx(
  packageId: string,
  allowlistId: string,
  entryId: string,
  newLocation: string,
): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::acl_encrypt::update_entry`,
    arguments: [
      tx.object(allowlistId),
      tx.object(entryId),
      tx.pure.vector('u8', textBytes(newLocation)),
    ],
  })
  return tx
}

export function editEntryTx(
  packageId: string,
  allowlistId: string,
  entryId: string,
  newLocation: string,
): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::acl_encrypt::edit_entry`,
    arguments: [
      tx.object(allowlistId),
      tx.object(entryId),
      tx.pure.vector('u8', textBytes(newLocation)),
    ],
  })
  return tx
}

export function transferAdminCapTx(
  capId: string,
  newOwner: string,
): Transaction {
  const tx = new Transaction()
  tx.transferObjects([tx.object(capId)], tx.pure.address(newOwner))
  return tx
}

/**
 * Extract the address from an `address` role. Throws for unsupported role types.
 */
export function roleToAddress(role: Role): string {
  if (role.type === 'address') return role.address
  throw new AclClientError(
    AclError.NotImplemented,
    `Role type '${role.type}' requires a contract upgrade (tribe roles are not yet supported)`,
  )
}
