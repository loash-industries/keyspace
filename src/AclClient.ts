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
        c.type === 'created' &&
        c.objectType.includes('::keyspace::Keyspace'),
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
   * Returns true if `address` is in the Read principal list.
   * OU (dao) principals are not checked here — use getAcl for full detail.
   */
  async hasAccess(opts: { aclId: string; address: string }): Promise<boolean> {
    const acl = await this.getAcl(opts.aclId)
    return acl.readPrincipals.some(
      (p) => p.type === 'player' && p.address === opts.address,
    )
  }

  // ── Data operations ─────────────────────────────────────────────────────────

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

    const location = await this.storageAdapter.upload(encrypted)

    const tx = publishEntryTx(
      this.packageId,
      opts.aclId,
      daoId,
      location,
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

    return { entryId: entryChange.objectId, location, epoch: meta.epoch }
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

    const encrypted = await this.storageAdapter.download(entry.location)

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

    const location = await this.storageAdapter.upload(encrypted)

    const tx = editEntryTx(
      this.packageId,
      opts.aclId,
      opts.entryId,
      daoId,
      location,
    )
    await this.executor(tx)

    return { entryId: opts.entryId, location, epoch: meta.epoch }
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

    const newLocation = await this.storageAdapter.upload(encrypted)

    const tx = updateEntryTx(
      this.packageId,
      opts.aclId,
      opts.entryId,
      daoId,
      newLocation,
    )
    await this.executor(tx)

    return { newLocation, epoch: meta.epoch }
  }

  async rotateAllStaleEntries(opts: {
    aclId: string
    walletAddress: string
    signPersonalMessage: SignPersonalMessageFn
    daoId?: string
    onProgress?: (done: number, total: number) => void
  }): Promise<RotateAllResult> {
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
