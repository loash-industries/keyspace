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
  createKeyspaceForDaoTx,
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

export class AclClient {
  private readonly suiClient: AclClientConfig['suiClient']
  private readonly sealClient: AclClientConfig['sealClient']
  private readonly packageId: string
  private readonly executor: AclClientConfig['executor']
  private readonly storageAdapter: AclClientConfig['storageAdapter']
  private readonly defaultDaoId?: string
  private readonly indexerUrl?: string
  private readonly sessionKeyTtlMin: number

  constructor(config: AclClientConfig) {
    this.suiClient = config.suiClient
    this.sealClient = config.sealClient
    this.packageId = config.packageId
    this.executor = config.executor
    this.storageAdapter = config.storageAdapter
    this.defaultDaoId = config.daoId
    this.indexerUrl = config.indexerUrl
    this.sessionKeyTtlMin = config.sessionKeyTtlMin ?? 10
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private requireDaoId(override?: string): string {
    const id = override ?? this.defaultDaoId
    if (!id) {
      throw new AclClientError(
        AclError.DaoIdRequired,
        'This operation requires a daoId. Pass it per-method or set daoId in AclClientConfig.',
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
   * Create a DAO-linked Keyspace.  The DAO's on-chain identity is recorded in
   * the `KeyspaceCreated` event as `registrant_dao_id` so an indexer can map
   * DAO → keyspaces without replaying Grant-role membership lists.
   *
   * The Move entry point takes a `&DAO` witness and calls
   * `is_governance_member`, so both the DAO reference and the caller's
   * membership are verified on-chain — `registrant_dao_id` cannot be spoofed.
   *
   * `grantPrincipals` must be non-empty (mirrors `EEmptyGrantPrincipals`).
   * `readPrincipals` and `writePrincipals` default to empty and can be
   * populated later via `grant`.
   */
  async createAclForDao(opts: {
    name: string
    daoId: string
    grantPrincipals: Principal[]
    readPrincipals?: Principal[]
    writePrincipals?: Principal[]
  }): Promise<CreateAclResult> {
    const tx = createKeyspaceForDaoTx(
      this.packageId,
      opts.daoId,
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
        'createAclForDao: expected Keyspace in objectChanges. Ensure executor returns showObjectChanges: true.',
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
    return fetchAccessibleKeyspaces(this.indexerUrl, address)
  }

  // ── Role management ─────────────────────────────────────────────────────────

  /**
   * Grant `principal` the `keyspaceRole` on `aclId`.
   * Caller must already hold the Grant role.
   * `daoId` overrides the config-level default.
   */
  async grant(opts: {
    aclId: string
    keyspaceRole: KeyspaceRole
    principal: Principal
    daoId?: string
  }): Promise<{ epoch: number }> {
    const daoId = this.requireDaoId(opts.daoId)
    const tx = grantTx(
      this.packageId,
      opts.aclId,
      daoId,
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
    daoId?: string
  }): Promise<{ epoch: number }> {
    const daoId = this.requireDaoId(opts.daoId)
    const tx = revokeTx(
      this.packageId,
      opts.aclId,
      daoId,
      opts.keyspaceRole,
      opts.principal,
    )
    await this.executor(tx)
    const meta = await this.getAclMeta(opts.aclId)
    return { epoch: meta.epoch }
  }

  /**
   * Returns true if `address` holds Read access either directly as a player
   * principal, or indirectly via an OU principal whose `daoId` is supplied.
   * Pass `daoId` to check OU membership; omit to check player membership only.
   */
  async hasAccess(opts: {
    aclId: string
    address: string
    daoId?: string
  }): Promise<boolean> {
    const acl = await this.getAcl(opts.aclId)
    return acl.readPrincipals.some(
      (p) =>
        (p.type === 'player' && p.address === opts.address) ||
        (p.type === 'ou' && opts.daoId !== undefined && p.daoId === opts.daoId),
    )
  }

  // ── Data operations ─────────────────────────────────────────────────────────

  async editDescription(opts: {
    aclId: string
    entryId: string
    newDescription: string
    daoId?: string
  }): Promise<void> {
    const daoId = this.requireDaoId(opts.daoId)
    const tx = editDescriptionTx(
      this.packageId,
      opts.aclId,
      opts.entryId,
      daoId,
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
    daoId?: string
  }): Promise<WriteResult> {
    const daoId = this.requireDaoId(opts.daoId)
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
      daoId,
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
    daoId?: string
  }): Promise<Uint8Array> {
    const daoId = this.requireDaoId(opts.daoId)
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
      daoId,
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
    daoId?: string
  }): Promise<WriteResult> {
    const daoId = this.requireDaoId(opts.daoId)
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

    const tx = editEntryTx(this.packageId, opts.aclId, opts.entryId, daoId, uri)
    await this.executor(tx)

    return { entryId: opts.entryId, uri, epoch: meta.epoch }
  }

  async rotateEntry(opts: {
    aclId: string
    entryId: string
    walletAddress: string
    signPersonalMessage: SignPersonalMessageFn
    daoId?: string
  }): Promise<RotateResult> {
    const daoId = this.requireDaoId(opts.daoId)
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
      daoId,
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
      daoId,
      newUri,
    )
    await this.executor(tx)

    return { newUri, epoch: meta.epoch }
  }

  async rotateAllStaleEntries(opts: {
    aclId: string
    walletAddress: string
    signPersonalMessage: SignPersonalMessageFn
    daoId?: string
    onProgress?: (done: number, total: number) => void
  }): Promise<RotateAllResult> {
    this.requireDaoId(opts.daoId)
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
          daoId: opts.daoId,
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
