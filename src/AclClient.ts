import type {
  AclClientConfig,
  AclDetail,
  AclMeta,
  CreateAclResult,
  EntryMeta,
  KeyspaceRole,
  Principal,
  RotateAllResult,
  RotateResult,
  SignPersonalMessageFn,
  WriteResult,
} from './types'
import { AclClientError, AclError } from './errors'
import {
  createKeyspaceTx,
  createKeyspaceForOuTx,
  editDescriptionTx,
  editEntryTx,
  grantTx,
  publishEntryTx,
  revokeTx,
  updateEntryTx,
} from './transactions'
import {
  fetchAccessibleKeyspaces,
  fetchEncryptedEntry,
  fetchKeyspaceDetail,
  fetchKeyspaceMeta,
} from './queries'
import { sealDecrypt, sealEncrypt } from './seal_helpers'

/** Default indexer: the Trinary Exchange gateway. */
const DEFAULT_INDEXER_URL = 'https://api.trinary.exchange'

export class AclClient {
  private readonly suiClient: AclClientConfig['suiClient']
  private readonly sealClient: AclClientConfig['sealClient']
  private readonly packageId: string
  private readonly executor: AclClientConfig['executor']
  private readonly storageAdapter: AclClientConfig['storageAdapter']
  private readonly defaultOuId?: string
  private readonly indexerUrl: string
  private readonly apiKey: string
  private readonly sessionKeyTtlMin: number

  constructor(config: AclClientConfig) {
    this.suiClient = config.suiClient
    this.sealClient = config.sealClient
    this.packageId = config.packageId
    this.executor = config.executor
    this.storageAdapter = config.storageAdapter
    this.defaultOuId = config.ouId
    this.indexerUrl = config.indexerUrl ?? DEFAULT_INDEXER_URL
    this.apiKey = config.apiKey
    this.sessionKeyTtlMin = config.sessionKeyTtlMin ?? 10
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private requireOuId(override?: string): string {
    const id = override ?? this.defaultOuId
    if (!id) {
      throw new AclClientError(
        AclError.OuIdRequired,
        'This operation requires an ouId. Pass it per-method or set ouId in AclClientConfig.',
      )
    }
    return id
  }

  // ── Keyspace lifecycle ──────────────────────────────────────────────────────

  async createAcl(opts: { name: string }): Promise<CreateAclResult> {
    const tx = createKeyspaceTx(this.packageId, opts.name)
    const result = await this.executor(tx)
    const changes = result.objectChanges ?? []

    const created = changes.find(
      (c) =>
        c.type === 'created' && c.objectType.includes('::keyspace::Keyspace'),
    )
    if (!created) {
      throw new AclClientError(
        AclError.UnexpectedResponse,
        'createAcl: expected Keyspace in objectChanges. Ensure executor returns showObjectChanges: true.',
      )
    }

    const meta = await this.getAclMeta(created.objectId)
    return { aclId: created.objectId, epoch: meta.epoch }
  }

  /**
   * Create an OU-linked Keyspace.  The OU's on-chain identity is recorded in
   * the `KeyspaceCreated` event as `registrant_dao_id` so an indexer can map
   * OU → keyspaces without replaying Grant-role membership lists.
   *
   * The Move entry point takes a `&DAO` witness and calls
   * `is_governance_member`, so both the OU reference and the caller's
   * membership are verified on-chain — `registrant_dao_id` cannot be spoofed.
   *
   * `grantPrincipals` must be non-empty (mirrors `EEmptyGrantPrincipals`).
   * `readPrincipals` and `writePrincipals` default to empty and can be
   * populated later via `grant`.
   */
  async createAclForOu(opts: {
    name: string
    ouId: string
    grantPrincipals: Principal[]
    readPrincipals?: Principal[]
    writePrincipals?: Principal[]
  }): Promise<CreateAclResult> {
    const tx = createKeyspaceForOuTx(
      this.packageId,
      opts.ouId,
      opts.name,
      opts.grantPrincipals,
      opts.readPrincipals ?? [],
      opts.writePrincipals ?? [],
    )
    const result = await this.executor(tx)
    const changes = result.objectChanges ?? []

    const created = changes.find(
      (c) =>
        c.type === 'created' && c.objectType.includes('::keyspace::Keyspace'),
    )
    if (!created) {
      throw new AclClientError(
        AclError.UnexpectedResponse,
        'createAclForOu: expected Keyspace in objectChanges. Ensure executor returns showObjectChanges: true.',
      )
    }

    const meta = await this.getAclMeta(created.objectId)
    return { aclId: created.objectId, epoch: meta.epoch }
  }

  async getAcl(aclId: string): Promise<AclDetail> {
    const detail = await fetchKeyspaceDetail(this.suiClient, aclId)
    if (!detail) {
      throw new AclClientError(
        AclError.EntryNotFound,
        `Keyspace not found: ${aclId}`,
      )
    }
    return detail
  }

  async getAccessibleAcls(address: string): Promise<string[]> {
    if (!this.indexerUrl) {
      throw new AclClientError(
        AclError.IndexerRequired,
        'getAccessibleAcls requires an indexerUrl in AclClient config',
      )
    }
    return fetchAccessibleKeyspaces(this.indexerUrl, address, this.apiKey)
  }

  // ── Role management ─────────────────────────────────────────────────────────

  /**
   * Grant `principal` the `keyspaceRole` on `aclId`.
   * Caller must already hold the Grant role.
   * `ouId` overrides the config-level default.
   */
  async grant(opts: {
    aclId: string
    keyspaceRole: KeyspaceRole
    principal: Principal
    ouId?: string
  }): Promise<{ epoch: number }> {
    const ouId = this.requireOuId(opts.ouId)
    const tx = grantTx(
      this.packageId,
      opts.aclId,
      ouId,
      opts.keyspaceRole,
      opts.principal,
    )
    await this.executor(tx)
    const meta = await this.getAclMeta(opts.aclId)
    return { epoch: meta.epoch }
  }

  /**
   * Revoke `principal` from `keyspaceRole` on `aclId`.
   * Caller must hold the Grant role.
   */
  async revoke(opts: {
    aclId: string
    keyspaceRole: KeyspaceRole
    principal: Principal
    ouId?: string
  }): Promise<{ epoch: number }> {
    const ouId = this.requireOuId(opts.ouId)
    const tx = revokeTx(
      this.packageId,
      opts.aclId,
      ouId,
      opts.keyspaceRole,
      opts.principal,
    )
    await this.executor(tx)
    const meta = await this.getAclMeta(opts.aclId)
    return { epoch: meta.epoch }
  }

  /**
   * Returns true if `address` holds Read access either directly as a player
   * principal, or indirectly via an OU principal whose `ouId` is supplied.
   * Pass `ouId` to check OU membership; omit to check player membership only.
   */
  async hasAccess(opts: {
    aclId: string
    address: string
    ouId?: string
  }): Promise<boolean> {
    const acl = await this.getAcl(opts.aclId)
    return acl.readPrincipals.some(
      (p) =>
        (p.type === 'player' && p.address === opts.address) ||
        (p.type === 'ou' && opts.ouId !== undefined && p.ouId === opts.ouId),
    )
  }

  // ── Data operations ─────────────────────────────────────────────────────────

  async editDescription(opts: {
    aclId: string
    entryId: string
    newDescription: string
    ouId?: string
  }): Promise<void> {
    const ouId = this.requireOuId(opts.ouId)
    const tx = editDescriptionTx(
      this.packageId,
      opts.aclId,
      opts.entryId,
      ouId,
      opts.newDescription,
    )
    await this.executor(tx)
  }

  async writeData(opts: {
    aclId: string
    plaintext: Uint8Array | string
    description: string
    walletAddress: string
    signPersonalMessage: SignPersonalMessageFn
    ouId?: string
  }): Promise<WriteResult> {
    const ouId = this.requireOuId(opts.ouId)
    const meta = await this.getAclMeta(opts.aclId)

    const data =
      typeof opts.plaintext === 'string'
        ? new TextEncoder().encode(opts.plaintext)
        : opts.plaintext

    const encrypted = await sealEncrypt(
      this.sealClient,
      this.packageId,
      opts.aclId,
      data,
    )

    const uri = await this.storageAdapter.upload(encrypted)

    const tx = publishEntryTx(
      this.packageId,
      opts.aclId,
      ouId,
      uri,
      opts.description,
    )
    const result = await this.executor(tx)

    const entryChange = (result.objectChanges ?? []).find(
      (c) =>
        c.type === 'created' &&
        c.objectType.includes('::keyspace::EncryptedEntry'),
    )
    if (!entryChange) {
      throw new AclClientError(
        AclError.UnexpectedResponse,
        'writeData: expected EncryptedEntry in objectChanges. Ensure executor returns showObjectChanges: true.',
      )
    }

    return { entryId: entryChange.objectId, uri, epoch: meta.epoch }
  }

  async readData(opts: {
    aclId: string
    entryId: string
    walletAddress: string
    signPersonalMessage: SignPersonalMessageFn
    ouId?: string
  }): Promise<Uint8Array> {
    const ouId = this.requireOuId(opts.ouId)
    const meta = await this.getAclMeta(opts.aclId)
    const entry = await fetchEncryptedEntry(
      this.suiClient,
      opts.entryId,
      meta.epoch,
    )
    if (!entry) {
      throw new AclClientError(
        AclError.EntryNotFound,
        `Entry not found: ${opts.entryId}`,
      )
    }

    const encrypted = await this.storageAdapter.download(entry.uri)

    return sealDecrypt({
      packageId: this.packageId,
      keyspaceId: opts.aclId,
      ouId,
      encryptedData: encrypted,
      walletAddress: opts.walletAddress,
      signPersonalMessage: opts.signPersonalMessage,
      suiClient: this.suiClient,
      sealClient: this.sealClient,
      sessionKeyTtlMin: this.sessionKeyTtlMin,
    })
  }

  async editData(opts: {
    aclId: string
    entryId: string
    newPlaintext: Uint8Array | string
    walletAddress: string
    signPersonalMessage: SignPersonalMessageFn
    ouId?: string
  }): Promise<WriteResult> {
    const ouId = this.requireOuId(opts.ouId)
    const meta = await this.getAclMeta(opts.aclId)

    const data =
      typeof opts.newPlaintext === 'string'
        ? new TextEncoder().encode(opts.newPlaintext)
        : opts.newPlaintext

    const encrypted = await sealEncrypt(
      this.sealClient,
      this.packageId,
      opts.aclId,
      data,
    )

    const uri = await this.storageAdapter.upload(encrypted)

    const tx = editEntryTx(this.packageId, opts.aclId, opts.entryId, ouId, uri)
    await this.executor(tx)

    return { entryId: opts.entryId, uri, epoch: meta.epoch }
  }

  async rotateEntry(opts: {
    aclId: string
    entryId: string
    walletAddress: string
    signPersonalMessage: SignPersonalMessageFn
    ouId?: string
  }): Promise<RotateResult> {
    const ouId = this.requireOuId(opts.ouId)
    const meta = await this.getAclMeta(opts.aclId)
    const entry = await fetchEncryptedEntry(
      this.suiClient,
      opts.entryId,
      meta.epoch,
    )
    if (!entry) {
      throw new AclClientError(
        AclError.EntryNotFound,
        `Entry not found: ${opts.entryId}`,
      )
    }
    if (!entry.isStale) {
      throw new AclClientError(
        AclError.AlreadyCurrentEpoch,
        `Entry ${opts.entryId} is already at the current epoch`,
      )
    }

    const plaintext = await this.readData({
      aclId: opts.aclId,
      entryId: opts.entryId,
      walletAddress: opts.walletAddress,
      signPersonalMessage: opts.signPersonalMessage,
      ouId,
    })

    const encrypted = await sealEncrypt(
      this.sealClient,
      this.packageId,
      opts.aclId,
      plaintext,
    )

    const newUri = await this.storageAdapter.upload(encrypted)

    const tx = updateEntryTx(
      this.packageId,
      opts.aclId,
      opts.entryId,
      ouId,
      newUri,
    )
    await this.executor(tx)

    return { newUri, epoch: meta.epoch }
  }

  async rotateAllStaleEntries(opts: {
    aclId: string
    walletAddress: string
    signPersonalMessage: SignPersonalMessageFn
    ouId?: string
    onProgress?: (done: number, total: number) => void
  }): Promise<RotateAllResult> {
    this.requireOuId(opts.ouId)
    const stale = await this.getStaleEntries(opts.aclId)
    let rotated = 0
    let skipped = 0

    for (const entry of stale) {
      try {
        await this.rotateEntry({
          aclId: opts.aclId,
          entryId: entry.id,
          walletAddress: opts.walletAddress,
          signPersonalMessage: opts.signPersonalMessage,
          ouId: opts.ouId,
        })
        rotated++
      } catch (e) {
        if (
          e instanceof AclClientError &&
          e.code === AclError.AlreadyCurrentEpoch
        ) {
          skipped++
        } else {
          throw e
        }
      }
      opts.onProgress?.(rotated + skipped, stale.length)
    }

    return { rotated, skipped }
  }

  // ── Epoch & staleness ────────────────────────────────────────────────────────

  async getStaleEntries(aclId: string): Promise<EntryMeta[]> {
    const detail = await this.getAcl(aclId)
    return detail.entries.filter((e) => e.isStale)
  }

  async isEntryStale(opts: {
    aclId: string
    entryId: string
  }): Promise<boolean> {
    const meta = await this.getAclMeta(opts.aclId)
    const entry = await fetchEncryptedEntry(
      this.suiClient,
      opts.entryId,
      meta.epoch,
    )
    if (!entry) {
      throw new AclClientError(
        AclError.EntryNotFound,
        `Entry not found: ${opts.entryId}`,
      )
    }
    return entry.isStale
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private async getAclMeta(aclId: string): Promise<AclMeta> {
    const meta = await fetchKeyspaceMeta(this.suiClient, aclId)
    if (!meta) {
      throw new AclClientError(
        AclError.EntryNotFound,
        `Keyspace not found: ${aclId}`,
      )
    }
    return meta
  }
}

// ── Client-side (browser) usage ────────────────────────────────────────────

/**
 * `AclClient` minus `getAccessibleAcls` — the one method that reads
 * `config.apiKey`. That key authenticates requests to the Trinary Exchange
 * indexer and is a server-only secret; it must never ship to a browser.
 * Every other method (`getAcl`, `createAcl`, `grant`, `revoke`,
 * `rotateAllStaleEntries`, `writeData`/`readData`, ...) needs no `apiKey` and
 * is safe to call from client-side code.
 */
export type PublicAclClient = Omit<AclClient, 'getAccessibleAcls'>

/**
 * Build an `AclClient` for browser / client-side code. Takes the same config
 * as `new AclClient(...)` minus `apiKey` — there is no client-side key to
 * supply. The return type is `PublicAclClient`, so `getAccessibleAcls` isn't
 * callable through it: nothing tempts a caller into wiring a real indexer
 * key into browser-shipped code, or into calling the method with a key that
 * doesn't exist.
 *
 * Need accessible-ACLs data in a browser app? Fetch it from your own
 * backend: hold a full `AclClient` (constructed with the real `apiKey`)
 * server-side, call `getAccessibleAcls()` there, and return the result to
 * the client.
 */
export function createPublicAclClient(
  config: Omit<AclClientConfig, 'apiKey'>,
): PublicAclClient {
  return new AclClient({ ...config, apiKey: '' })
}

// ── Read-only usage ─────────────────────────────────────────────────────────

/**
 * Config for `ReadOnlyAclClient`. Unlike `AclClientConfig`, `packageId`,
 * `executor`, `storageAdapter`, and `sealClient` are all omitted — none of
 * `ReadOnlyAclClient`'s methods sign/submit transactions, touch encrypted
 * blob storage, or decrypt entries, so there's nothing to construct those
 * with. `indexerUrl` and `apiKey` are optional for the same reason
 * `getAccessibleAcls` treats them as optional on the full client: an indexer
 * that serves public reads without a key still works, it just needs
 * `indexerUrl` to point at it.
 */
export interface ReadOnlyAclClientConfig {
  /** @mysten/sui SuiClient instance */
  suiClient: AclClientConfig['suiClient']
  /**
   * REST indexer URL for getAccessibleAcls.
   * Defaults to the Trinary Exchange gateway (`https://api.trinary.exchange`).
   */
  indexerUrl?: string
  /**
   * Trinary Exchange API key used to authenticate indexer requests. Sent as
   * the `x-api-key` header. Omit if the indexer allows unauthenticated reads.
   */
  apiKey?: string
}

/**
 * A read-only view over a Keyspace: on-chain lookups plus the indexer-backed
 * `getAccessibleAcls` call, with no ability to create/grant/revoke/write.
 * Takes no `packageId`, `executor`, `storageAdapter`, or `sealClient` — this
 * is meant for callers (e.g. a read API or a UI's server route) that only
 * ever need to look up ACL state, never mutate it or decrypt entries.
 */
export class ReadOnlyAclClient {
  private readonly suiClient: AclClientConfig['suiClient']
  private readonly indexerUrl: string
  private readonly apiKey?: string

  constructor(config: ReadOnlyAclClientConfig) {
    this.suiClient = config.suiClient
    this.indexerUrl = config.indexerUrl ?? DEFAULT_INDEXER_URL
    this.apiKey = config.apiKey
  }

  async getAcl(aclId: string): Promise<AclDetail> {
    const detail = await fetchKeyspaceDetail(this.suiClient, aclId)
    if (!detail) {
      throw new AclClientError(
        AclError.EntryNotFound,
        `Keyspace not found: ${aclId}`,
      )
    }
    return detail
  }

  async getAccessibleAcls(address: string): Promise<string[]> {
    return fetchAccessibleKeyspaces(this.indexerUrl, address, this.apiKey ?? '')
  }

  /**
   * Returns true if `address` holds Read access either directly as a player
   * principal, or indirectly via an OU principal whose `ouId` is supplied.
   * Pass `ouId` to check OU membership; omit to check player membership only.
   */
  async hasAccess(opts: {
    aclId: string
    address: string
    ouId?: string
  }): Promise<boolean> {
    const acl = await this.getAcl(opts.aclId)
    return acl.readPrincipals.some(
      (p) =>
        (p.type === 'player' && p.address === opts.address) ||
        (p.type === 'ou' && opts.ouId !== undefined && p.ouId === opts.ouId),
    )
  }

  async getStaleEntries(aclId: string): Promise<EntryMeta[]> {
    const detail = await this.getAcl(aclId)
    return detail.entries.filter((e) => e.isStale)
  }

  async isEntryStale(opts: { aclId: string; entryId: string }): Promise<boolean> {
    const meta = await this.getAclMeta(opts.aclId)
    const entry = await fetchEncryptedEntry(
      this.suiClient,
      opts.entryId,
      meta.epoch,
    )
    if (!entry) {
      throw new AclClientError(
        AclError.EntryNotFound,
        `Entry not found: ${opts.entryId}`,
      )
    }
    return entry.isStale
  }

  private async getAclMeta(aclId: string): Promise<AclMeta> {
    const meta = await fetchKeyspaceMeta(this.suiClient, aclId)
    if (!meta) {
      throw new AclClientError(
        AclError.EntryNotFound,
        `Keyspace not found: ${aclId}`,
      )
    }
    return meta
  }
}
