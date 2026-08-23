import { Transaction } from '@mysten/sui/transactions'
import { bcs } from '@mysten/bcs'
import { fromHex } from '@mysten/sui/utils'
import type { KeyspaceRole, Principal } from './types'
import { AclClientError, AclError } from './errors'
import { principalId, principalKind } from './principals'

// ── BCS schemas for Move types ────────────────────────────────────────────────
//
// armature_vault::keyspace::Role  (enum, no-field variants)
// armature_vault::acl::Principal  (enum with fields)

const RoleSchema = bcs.enum('Role', {
  Grant: null,
  Read: null,
  Write: null,
})

// armature_vault::acl::Principal (v1). The on-chain enum's variant set is
// FROZEN by Sui upgrade compatibility, so this schema can never grow — new
// principal kinds go through PrincipalV2Schema below.
const PrincipalSchema = bcs.enum('Principal', {
  Player: bcs.struct('Player', { addr: bcs.bytes(32) }),
  Ou: bcs.struct('Ou', { dao_id: bcs.bytes(32) }),
})

// armature_vault::acl::PrincipalV2 — the upgradeable successor. A struct, not
// an enum: the kind is a u8 tag, so new kinds need no schema change here.
const PrincipalV2Schema = bcs.struct('PrincipalV2', {
  kind: bcs.u8(),
  id: bcs.bytes(32),
  data: bcs.vector(bcs.u8()),
})

function encodePrincipalV2(principal: Principal) {
  return PrincipalV2Schema.serialize({
    kind: principalKind(principal),
    id: fromHex(principalId(principal)),
    data: [],
  })
}

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
      // The on-chain Principal enum is frozen and has no machine variant —
      // machines are v2-only (AclClient.grant/revoke route them there).
      throw new AclClientError(
        AclError.ValidationFailed,
        'machine principals require the v2 ACL — use grantV2Tx/revokeV2Tx',
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
      // Keyspace creation takes v1 principals only (its signature is frozen).
      // Grant machines with grantV2Tx once the keyspace exists.
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
 * `keyspace::grant_v2(keyspace, role, principal, dao)` — grants into the
 * upgradeable v2 principal ACL. Accepts every principal kind, including
 * `machine`, which exists only here. Requires a v3+ armature_vault deployment.
 */
export function grantV2Tx(
  packageId: string,
  keyspaceId: string,
  ouId: string,
  role: KeyspaceRole,
  principal: Principal,
): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::keyspace::grant_v2`,
    arguments: [
      tx.object(keyspaceId),
      tx.pure(encodeRole(role)),
      tx.pure(encodePrincipalV2(principal)),
      tx.object(ouId),
    ],
  })
  return tx
}

/** `keyspace::revoke_v2(keyspace, role, principal, dao)` */
export function revokeV2Tx(
  packageId: string,
  keyspaceId: string,
  ouId: string,
  role: KeyspaceRole,
  principal: Principal,
): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::keyspace::revoke_v2`,
    arguments: [
      tx.object(keyspaceId),
      tx.pure(encodeRole(role)),
      tx.pure(encodePrincipalV2(principal)),
      tx.object(ouId),
    ],
  })
  return tx
}

/**
 * `keyspace::migrate_acl_to_v2(keyspace, dao)` — lifts the keyspace's v1
 * principals into the v2 store. Access-neutral and idempotent, but it empties
 * the object's `acl` field, which SDKs older than this major read directly:
 * migrate only once your consumers are upgraded.
 */
export function migrateAclToV2Tx(
  packageId: string,
  keyspaceId: string,
  ouId: string,
): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::keyspace::migrate_acl_to_v2`,
    arguments: [tx.object(keyspaceId), tx.object(ouId)],
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
