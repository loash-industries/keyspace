import type { Transaction } from '@mysten/sui/transactions'

// ── Principal ─────────────────────────────────────────────────────────────────
// Mirrors armature_vault::acl::Principal

export type Principal =
  | { type: 'player'; address: string }
  | { type: 'ou'; daoId: string }

/** @deprecated Use Principal */
export type Role = Principal

// ── Keyspace role ─────────────────────────────────────────────────────────────
// Mirrors armature_vault::keyspace::Role

export type KeyspaceRole = 'Grant' | 'Read' | 'Write'

// ── Keyspace state ────────────────────────────────────────────────────────────

export interface AclMeta {
  id: string
  name: string
  /** Incremented when the Read membership set changes (= on-chain `version`). */
  epoch: number
  entryCount: number
}

export interface AclDetail extends AclMeta {
  /** Principals that hold the Grant role (can manage membership). */
  grantPrincipals: Principal[]
  /** Principals that hold the Read role (can decrypt entries). */
  readPrincipals: Principal[]
  /** Principals that hold the Write role (can publish/edit entries). */
  writePrincipals: Principal[]
  /**
   * Backwards-compat alias for readPrincipals — "members who can decrypt".
   * Use readPrincipals / grantPrincipals / writePrincipals for new code.
   */
  roles: Principal[]
  entries: EntryMeta[]
}

export interface EntryMeta {
  id: string
  /** Object ID of the parent Keyspace. */
  keyspaceId: string
  location: string
  description: string
  createdBy: string
  epoch: number
  isStale: boolean
}

// ── Operation results ─────────────────────────────────────────────────────────

export interface CreateAclResult {
  /** The Keyspace object ID. */
  aclId: string
  epoch: number
}

export interface WriteResult {
  entryId: string
  location: string
  epoch: number
}

export interface RotateResult {
  newLocation: string
  epoch: number
}

export interface RotateAllResult {
  rotated: number
  skipped: number
}

// ── Executor ──────────────────────────────────────────────────────────────────

export interface ObjectChange {
  type: string
  objectId: string
  objectType: string
}

export interface ExecuteResult {
  digest: string
  objectChanges?: ObjectChange[]
}

/**
 * Callback the consumer provides to sign and submit transactions.
 *
 * In a dapp-kit app:
 *   executor: (tx) => signAndExecuteTransaction({ transaction: tx, options: { showObjectChanges: true } })
 */
export type TransactionExecutor = (tx: Transaction) => Promise<ExecuteResult>

// ── Signing ───────────────────────────────────────────────────────────────────

/**
 * Signs a personal message for Seal session key creation.
 * Returns the base64-encoded signature string.
 */
export type SignPersonalMessageFn = (message: Uint8Array) => Promise<string>

// ── Storage ───────────────────────────────────────────────────────────────────

export interface StorageAdapter {
  upload(data: Uint8Array): Promise<string>
  download(location: string): Promise<Uint8Array>
}

// ── Client config ─────────────────────────────────────────────────────────────

export interface AclClientConfig {
  /** @mysten/sui SuiClient instance */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  suiClient: any
  /** @mysten/seal SealClient instance (pre-configured with key servers) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sealClient: any
  /** Published armature_vault package ID */
  packageId: string
  /** Signs and submits PTBs; must return objectChanges for mutation methods */
  executor: TransactionExecutor
  /** Encrypted blob storage backend */
  storageAdapter: StorageAdapter
  /**
   * Default DAO object ID to pass for operations that require `&DAO`.
   * Can be overridden per-method. Required for grant/revoke/write/read ops.
   */
  daoId?: string
  /** REST indexer URL for getAccessibleAcls — optional */
  indexerUrl?: string
  /** Seal session key TTL in minutes (default: 10) */
  sessionKeyTtlMin?: number
}
