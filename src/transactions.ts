import { Transaction } from '@mysten/sui/transactions'
import type { KeyspaceRole, Principal } from './types'

// ── Move enum arguments ───────────────────────────────────────────────────────
//
// armature_vault::keyspace::Role and armature_vault::acl::Principal are Move 2
// enums, which Sui's PTB validator does not accept as pure inputs. Build them
// on-chain with their constructor functions instead.

function buildRoleArg(tx: Transaction, packageId: string, role: KeyspaceRole) {
  switch (role) {
    case 'Grant':
      return tx.moveCall({ target: `${packageId}::keyspace::role_grant` })
    case 'Read':
      return tx.moveCall({ target: `${packageId}::keyspace::role_read` })
    case 'Write':
      return tx.moveCall({ target: `${packageId}::keyspace::role_write` })
    default:
      throw new Error(`Unknown KeyspaceRole: ${role satisfies never}`)
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
    case 'machine':
      return tx.moveCall({
        target: `${packageId}::acl::machine`,
        arguments: [tx.pure.address(p.address)],
      })
    case 'ou':
      // ID has the same 32-byte BCS encoding as address
      return tx.moveCall({
        target: `${packageId}::acl::ou`,
        arguments: [tx.pure.address(p.ouId)],
      })
    default:
      throw new Error(
        `Unknown principal type: ${(p satisfies never as Principal).type}`,
      )
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
 * `keyspace::create_keyspace_for_ou(name, org, grant, read, write)`
 *
 * The `ouId` is passed as an object reference (`tx.object`) so the Move VM
 * enforces the `&OU` witness; the caller's governance membership and the
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
    target: `${packageId}::keyspace::create_keyspace_for_ou`,
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
      buildRoleArg(tx, packageId, role),
      buildPrincipalArg(tx, packageId, principal),
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
      buildRoleArg(tx, packageId, role),
      buildPrincipalArg(tx, packageId, principal),
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
