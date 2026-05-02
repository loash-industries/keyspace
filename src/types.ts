import type { Transaction } from '@mysten/sui/transactions'

// ── Role ─────────────────────────────────────────────────────────────────────

export type Role =
  | { type: 'address'; address: string }
  | { type: 'tribe'; tribeId: string }

// ── ACL state ─────────────────────────────────────────────────────────────────

export interface AclMeta {
  id: string
  owner: string
  name: string
  epoch: number
  entryCount: number
}

export interface AclDetail extends AclMeta {
  roles: Role[]
  entries: EntryMeta[]
}

export interface EntryMeta {
  id: string
  aclId: string
  location: string
  description: string
  createdBy: string
  epoch: number
  isStale: boolean
}

export interface AdminCap {
  id: string
  aclId: string
}

// ── Operation results ─────────────────────────────────────────────────────────

export interface CreateAclResult {
  aclId: string
  adminCapId: string
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
 *
 * In a Node.js script:
 *   executor: async (tx) => {
 *     const result = await suiClient.signAndExecuteTransaction({ signer: keypair, transaction: tx });
 *     return result;
 *   }
 */
export type TransactionExecutor = (tx: Transaction) => Promise<ExecuteResult>

// ── Signing ───────────────────────────────────────────────────────────────────

/**
 * Signs a personal message for Seal session key creation.
 * Returns the base64-encoded signature string.
 *
 * In a dapp-kit app:
 *   signPersonalMessage: (message) => new Promise((resolve, reject) =>
 *     dappKitSignFn({ message }, { onSuccess: r => resolve(r.signature), onError: reject })
 *   )
 */
export type SignPersonalMessageFn = (message: Uint8Array) => Promise<string>

// ── Storage ───────────────────────────────────────────────────────────────────

export interface StorageAdapter {
  upload(data: Uint8Array): Promise<string> // returns location (ipfs://... or https://...)
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
  /** Deployed Move package ID */
  packageId: string
  /** Signs and submits PTBs; must return objectChanges for mutation methods */
  executor: TransactionExecutor
  /** Encrypted blob storage backend */
  storageAdapter: StorageAdapter
  /** REST indexer URL for getAccessibleAcls — optional */
  indexerUrl?: string
  /** Seal session key TTL in minutes (default: 10) */
  sessionKeyTtlMin?: number
}
