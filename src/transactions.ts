import { Transaction } from '@mysten/sui/transactions'
import { bcs } from '@mysten/bcs'
import { fromHex } from '@mysten/sui/utils'
import type { KeyspaceRole, Principal } from './types'

// ── BCS schemas for Move types ────────────────────────────────────────────────
//
// armature_vault::keyspace::Role  (enum, no-field variants)
// armature_vault::acl::Principal  (enum with fields)

const RoleSchema = bcs.enum('Role', {
  Grant: null,
  Read: null,
  Write: null,
})

const PrincipalSchema = bcs.enum('Principal', {
  Player: bcs.struct('Player', { addr: bcs.bytes(32) }),
  Ou: bcs.struct('Ou', { dao_id: bcs.bytes(32) }),
})

function encodeRole(role: KeyspaceRole) {
  switch (role) {
    case 'Grant':
      return RoleSchema.serialize({ Grant: null })
    case 'Read':
      return RoleSchema.serialize({ Read: null })
    case 'Write':
      return RoleSchema.serialize({ Write: null })
    default:
      throw new Error(`Unknown KeyspaceRole: ${role satisfies never}`)
  }
}

function encodePrincipal(principal: Principal) {
  if (principal.type === 'player') {
    return PrincipalSchema.serialize({
      Player: { addr: fromHex(principal.address) },
    })
  }
  return PrincipalSchema.serialize({
    Ou: { dao_id: fromHex(principal.daoId) },
  })
}

function textBytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s))
}

// ── Transactions ──────────────────────────────────────────────────────────────

/** `keyspace::create_keyspace(name)` — creator is seeded into Grant/Read/Write. */
export function createKeyspaceTx(packageId: string, name: string): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::keyspace::create_keyspace`,
    arguments: [tx.pure.vector('u8', textBytes(name))],
  })
  return tx
}

/** `keyspace::grant(keyspace, role, principal, dao)` */
export function grantTx(
  packageId: string,
  keyspaceId: string,
  daoId: string,
  role: KeyspaceRole,
  principal: Principal,
): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::keyspace::grant`,
    arguments: [
      tx.object(keyspaceId),
      tx.pure(encodeRole(role)),
      tx.pure(encodePrincipal(principal)),
      tx.object(daoId),
    ],
  })
  return tx
}

/** `keyspace::revoke(keyspace, role, principal, dao)` */
export function revokeTx(
  packageId: string,
  keyspaceId: string,
  daoId: string,
  role: KeyspaceRole,
  principal: Principal,
): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::keyspace::revoke`,
    arguments: [
      tx.object(keyspaceId),
      tx.pure(encodeRole(role)),
      tx.pure(encodePrincipal(principal)),
      tx.object(daoId),
    ],
  })
  return tx
}

/** `keyspace::publish_entry(keyspace, uri, description, dao)` */
export function publishEntryTx(
  packageId: string,
  keyspaceId: string,
  daoId: string,
  uri: string,
  description: string,
): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::keyspace::publish_entry`,
    arguments: [
      tx.object(keyspaceId),
      tx.pure.vector('u8', textBytes(uri)),
      tx.pure.vector('u8', textBytes(description)),
      tx.object(daoId),
    ],
  })
  return tx
}

/** `keyspace::update_entry(keyspace, entry, new_uri, dao)` — key rotation. */
export function updateEntryTx(
  packageId: string,
  keyspaceId: string,
  entryId: string,
  daoId: string,
  newUri: string,
): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::keyspace::update_entry`,
    arguments: [
      tx.object(keyspaceId),
      tx.object(entryId),
      tx.pure.vector('u8', textBytes(newUri)),
      tx.object(daoId),
    ],
  })
  return tx
}

/** `keyspace::edit_entry(keyspace, entry, new_uri, dao)` — same-epoch URI edit. */
export function editEntryTx(
  packageId: string,
  keyspaceId: string,
  entryId: string,
  daoId: string,
  newUri: string,
): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::keyspace::edit_entry`,
    arguments: [
      tx.object(keyspaceId),
      tx.object(entryId),
      tx.pure.vector('u8', textBytes(newUri)),
      tx.object(daoId),
    ],
  })
  return tx
}

/** `keyspace::edit_description(keyspace, entry, new_description, dao)` */
export function editDescriptionTx(
  packageId: string,
  keyspaceId: string,
  entryId: string,
  daoId: string,
  newDescription: string,
): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::keyspace::edit_description`,
    arguments: [
      tx.object(keyspaceId),
      tx.object(entryId),
      tx.pure.vector('u8', textBytes(newDescription)),
      tx.object(daoId),
    ],
  })
  return tx
}
