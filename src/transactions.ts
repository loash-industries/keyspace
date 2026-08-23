import { Transaction } from '@mysten/sui/transactions'
import { bcs } from '@mysten/bcs'
import { fromHex } from '@mysten/sui/utils'
import type { KeyspaceRole, Principal } from './types'
import { AclClientError, AclError } from './errors'

// ── BCS schemas for Move types ────────────────────────────────────────────────
//
// armature_vault::keyspace::Role  (enum, no-field variants)
// armature_vault::acl::Principal  (enum with fields)

const RoleSchema = bcs.enum('Role', {
  Grant: null,
  Read: null,
  Write: null,
})

// Mirrors armature_vault::acl::Principal exactly. The on-chain enum's variant
// set is FROZEN by Sui upgrade compatibility — machine principals are not a
// variant here and never will be; they travel through keyspace::grant_machine
// / revoke_machine as plain addresses (see grantMachineTx below).
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
  switch (principal.type) {
    case 'player':
      return PrincipalSchema.serialize({
        Player: { addr: fromHex(principal.address) },
      })
    case 'ou':
      return PrincipalSchema.serialize({
        Ou: { dao_id: fromHex(principal.ouId) },
      })
    case 'machine':
      // The on-chain Principal enum is frozen — machines use the machine-ACL
      // entry points instead (AclClient.grant/revoke route them there).
      throw new AclClientError(
        AclError.ValidationFailed,
        'machine principals use grantMachineTx/revokeMachineTx, not the Principal enum',
      )
    default:
      throw new Error(`Unknown Principal: ${principal satisfies never}`)
  }
}

function textBytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s))
}

function buildPrincipalArg(tx: Transaction, packageId: string, p: Principal) {
  switch (p.type) {
    case 'player':
      return tx.moveCall({
        target: `${packageId}::acl::player`,
        arguments: [tx.pure.address(p.address)],
      })
    case 'ou':
      // ID has the same 32-byte BCS encoding as address
      return tx.moveCall({
        target: `${packageId}::acl::ou`,
        arguments: [tx.pure.address(p.ouId)],
      })
    case 'machine':
      // Machines cannot seed keyspace creation — grant after create via
      // AclClient.grant (which routes to keyspace::grant_machine).
      throw new AclClientError(
        AclError.ValidationFailed,
        'machine principals cannot be seeded at keyspace creation; grant them after create',
      )
    default:
      throw new Error(`Unknown Principal: ${p satisfies never}`)
  }
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

/**
 * `keyspace::create_keyspace_for_dao(name, dao, grant, read, write)`
 *
 * The `ouId` is passed as an object reference (`tx.object`) so the Move VM
 * enforces the `&DAO` witness; the caller's governance membership and the
 * registrant OU ID are verified on-chain.
 */
export function createKeyspaceForOuTx(
  packageId: string,
  ouId: string,
  name: string,
  grantPrincipals: Principal[],
  readPrincipals: Principal[],
  writePrincipals: Principal[],
): Transaction {
  const tx = new Transaction()

  // vector<Principal> cannot be passed as a BCS pure arg — Move 2 enum types are
  // not accepted by Sui's PTB validator as pure inputs. Construct each principal
  // on-chain and collect into a typed vector instead.
  const buildVec = (principals: Principal[]) =>
    tx.makeMoveVec({
      type: `${packageId}::acl::Principal`,
      elements: principals.map((p) => buildPrincipalArg(tx, packageId, p)),
    })

  tx.moveCall({
    target: `${packageId}::keyspace::create_keyspace_for_dao`,
    arguments: [
      tx.pure.vector('u8', textBytes(name)),
      tx.object(ouId),
      buildVec(grantPrincipals),
      buildVec(readPrincipals),
      buildVec(writePrincipals),
    ],
  })
  return tx
}

/** `keyspace::grant(keyspace, role, principal, dao)` */
export function grantTx(
  packageId: string,
  keyspaceId: string,
  ouId: string,
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
      tx.object(ouId),
    ],
  })
  return tx
}

/**
 * `keyspace::grant_machine(keyspace, role, machine, dao)` — machine-ACL twin
 * of `grant`. Machines are addresses in a versioned dynamic field on the
 * Keyspace, not `Principal` enum values (the on-chain enum is frozen).
 * Requires a v3+ armature_vault deployment.
 */
export function grantMachineTx(
  packageId: string,
  keyspaceId: string,
  ouId: string,
  role: KeyspaceRole,
  machineAddress: string,
): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::keyspace::grant_machine`,
    arguments: [
      tx.object(keyspaceId),
      tx.pure(encodeRole(role)),
      tx.pure.address(machineAddress),
      tx.object(ouId),
    ],
  })
  return tx
}

/** `keyspace::revoke_machine(keyspace, role, machine, dao)` */
export function revokeMachineTx(
  packageId: string,
  keyspaceId: string,
  ouId: string,
  role: KeyspaceRole,
  machineAddress: string,
): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::keyspace::revoke_machine`,
    arguments: [
      tx.object(keyspaceId),
      tx.pure(encodeRole(role)),
      tx.pure.address(machineAddress),
      tx.object(ouId),
    ],
  })
  return tx
}

/** `keyspace::revoke(keyspace, role, principal, dao)` */
export function revokeTx(
  packageId: string,
  keyspaceId: string,
  ouId: string,
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
      tx.object(ouId),
    ],
  })
  return tx
}

/** `keyspace::publish_entry(keyspace, uri, description, dao)` */
export function publishEntryTx(
  packageId: string,
  keyspaceId: string,
  ouId: string,
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
      tx.object(ouId),
    ],
  })
  return tx
}

/** `keyspace::update_entry(keyspace, entry, new_uri, dao)` — key rotation. */
export function updateEntryTx(
  packageId: string,
  keyspaceId: string,
  entryId: string,
  ouId: string,
  newUri: string,
): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::keyspace::update_entry`,
    arguments: [
      tx.object(keyspaceId),
      tx.object(entryId),
      tx.pure.vector('u8', textBytes(newUri)),
      tx.object(ouId),
    ],
  })
  return tx
}

/** `keyspace::edit_entry(keyspace, entry, new_uri, dao)` — same-epoch URI edit. */
export function editEntryTx(
  packageId: string,
  keyspaceId: string,
  entryId: string,
  ouId: string,
  newUri: string,
): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::keyspace::edit_entry`,
    arguments: [
      tx.object(keyspaceId),
      tx.object(entryId),
      tx.pure.vector('u8', textBytes(newUri)),
      tx.object(ouId),
    ],
  })
  return tx
}

/** `keyspace::edit_description(keyspace, entry, new_description, dao)` */
export function editDescriptionTx(
  packageId: string,
  keyspaceId: string,
  entryId: string,
  ouId: string,
  newDescription: string,
): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::keyspace::edit_description`,
    arguments: [
      tx.object(keyspaceId),
      tx.object(entryId),
      tx.pure.vector('u8', textBytes(newDescription)),
      tx.object(ouId),
    ],
  })
  return tx
}
