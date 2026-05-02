import type {
  AclClientConfig,
  AclDetail,
  AclMeta,
  AdminCap,
  CreateAclResult,
  EntryMeta,
  Role,
  RotateAllResult,
  RotateResult,
  SignPersonalMessageFn,
  WriteResult,
} from './types.js'
import { AclClientError, AclError } from './errors.js'
import {
  addMemberTx,
  editEntryTx,
  publishEntryTx,
  removeMemberTx,
  roleToAddress,
  transferAdminCapTx,
  updateEntryTx,
} from './transactions.js'
import {
  fetchAccessibleAcls,
  fetchAdminCaps,
  fetchAllowListDetail,
  fetchAllowListMeta,
  fetchEncryptedEntry,
} from './queries.js'
import { sealDecrypt, sealEncrypt } from './seal_helpers.js'

export class AclClient {
  private readonly suiClient: AclClientConfig['suiClient']
  private readonly sealClient: AclClientConfig['sealClient']
  private readonly packageId: string
  private readonly executor: AclClientConfig['executor']
  private readonly storageAdapter: AclClientConfig['storageAdapter']
  private readonly indexerUrl?: string
  private readonly sessionKeyTtlMin: number

  constructor(config: AclClientConfig) {
    this.suiClient = config.suiClient
    this.sealClient = config.sealClient
    this.packageId = config.packageId
    this.executor = config.executor
    this.storageAdapter = config.storageAdapter
    this.indexerUrl = config.indexerUrl
    this.sessionKeyTtlMin = config.sessionKeyTtlMin ?? 10
  }

  // ── ACL Lifecycle ───────────────────────────────────────────────────────────

  async createAcl(opts: {
    name: string
    initialRoles?: Role[]
  }): Promise<CreateAclResult> {
    // Build a single PTB: create_allowlist + optional add() calls
    const { Transaction } = await import('@mysten/sui/transactions')
    const tx = new Transaction()

    tx.moveCall({
      target: `${this.packageId}::acl_encrypt::create_allowlist`,
      arguments: [
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(opts.name))),
      ],
    })

    const result = await this.executor(tx)
    const changes = result.objectChanges ?? []

    const aclChange = changes.find(
      (c) => c.type === 'created' && c.objectType.includes('::AllowList'),
    )
    const capChange = changes.find(
      (c) => c.type === 'created' && c.objectType.includes('::AdminCap'),
    )

    if (!aclChange || !capChange) {
      throw new AclClientError(
        AclError.UnexpectedResponse,
        'createAcl: expected AllowList and AdminCap in objectChanges. Ensure executor returns showObjectChanges: true.',
      )
    }

    const aclId = aclChange.objectId
    const adminCapId = capChange.objectId

    // Add initial roles in separate transactions (create_allowlist doesn't accept them atomically
    // in the current contract — each add() requires the AdminCap to already be owned)
    if (opts.initialRoles?.length) {
      for (const role of opts.initialRoles) {
        await this.addRole({ aclId, adminCapId, role })
      }
    }

    const meta = await this.getAcl(aclId)
    return { aclId, adminCapId, epoch: meta?.epoch ?? 0 }
  }

  async getAcl(aclId: string): Promise<AclDetail> {
    const detail = await fetchAllowListDetail(
      this.suiClient,
      this.packageId,
      aclId,
    )
    if (!detail) {
      throw new AclClientError(
        AclError.EntryNotFound,
        `ACL not found: ${aclId}`,
      )
    }
    return detail
  }

  async getOwnedAcls(address: string): Promise<AdminCap[]> {
    return fetchAdminCaps(this.suiClient, this.packageId, address)
  }

  async getAccessibleAcls(address: string): Promise<string[]> {
    if (!this.indexerUrl) {
      throw new AclClientError(
        AclError.IndexerRequired,
        'getAccessibleAcls requires an indexerUrl in AclClient config',
      )
    }
    return fetchAccessibleAcls(this.indexerUrl, address)
  }

  // ── Role Management ─────────────────────────────────────────────────────────

  async addRole(opts: {
    aclId: string
    adminCapId: string
    role: Role
  }): Promise<{ epoch: number }> {
    const grantee = roleToAddress(opts.role)
    const tx = addMemberTx(this.packageId, opts.aclId, opts.adminCapId, grantee)
    await this.executor(tx)
    const meta = await this.getAclMeta(opts.aclId)
    return { epoch: meta.epoch }
  }

  async removeRole(opts: {
    aclId: string
    adminCapId: string
    role: Role
  }): Promise<{ epoch: number }> {
    const grantee = roleToAddress(opts.role)
    const tx = removeMemberTx(
      this.packageId,
      opts.aclId,
      opts.adminCapId,
      grantee,
    )
    await this.executor(tx)
    const meta = await this.getAclMeta(opts.aclId)
    return { epoch: meta.epoch }
  }

  async hasAccess(opts: { aclId: string; address: string }): Promise<boolean> {
    const acl = await this.getAcl(opts.aclId)
    if (acl.owner === opts.address) return true
    return acl.roles.some(
      (r) => r.type === 'address' && r.address === opts.address,
    )
  }

  async resolveRoles(opts: {
    aclId: string
    address: string
  }): Promise<Role[]> {
    const acl = await this.getAcl(opts.aclId)
    return acl.roles.filter(
      (r) => r.type === 'address' && r.address === opts.address,
    )
  }

  // ── Data Operations ─────────────────────────────────────────────────────────

  async writeData(opts: {
    aclId: string
    plaintext: Uint8Array | string
    description: string
    walletAddress: string
    signPersonalMessage: SignPersonalMessageFn
  }): Promise<WriteResult> {
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
      location,
      opts.description,
    )
    const result = await this.executor(tx)

    const entryChange = (result.objectChanges ?? []).find(
      (c) => c.type === 'created' && c.objectType.includes('::EncryptedEntry'),
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
  }): Promise<Uint8Array> {
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
      allowlistId: opts.aclId,
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
  }): Promise<WriteResult> {
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

    const tx = editEntryTx(this.packageId, opts.aclId, opts.entryId, location)
    await this.executor(tx)

    return { entryId: opts.entryId, location, epoch: meta.epoch }
  }

  async rotateEntry(opts: {
    aclId: string
    entryId: string
    walletAddress: string
    signPersonalMessage: SignPersonalMessageFn
  }): Promise<RotateResult> {
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

    // Decrypt with old policy (entry's epoch)
    const plaintext = await this.readData({
      aclId: opts.aclId,
      entryId: opts.entryId,
      walletAddress: opts.walletAddress,
      signPersonalMessage: opts.signPersonalMessage,
    })

    // Re-encrypt under current epoch policy
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
      newLocation,
    )
    await this.executor(tx)

    return { newLocation, epoch: meta.epoch }
  }

  async rotateAllStaleEntries(opts: {
    aclId: string
    walletAddress: string
    signPersonalMessage: SignPersonalMessageFn
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

  // ── Epoch & Staleness ───────────────────────────────────────────────────────

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

  // ── Admin ───────────────────────────────────────────────────────────────────

  async transferAdminCap(opts: {
    adminCapId: string
    newOwner: string
  }): Promise<void> {
    const tx = transferAdminCapTx(opts.adminCapId, opts.newOwner)
    await this.executor(tx)
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private async getAclMeta(aclId: string): Promise<AclMeta> {
    const meta = await fetchAllowListMeta(this.suiClient, aclId)
    if (!meta) {
      throw new AclClientError(
        AclError.EntryNotFound,
        `ACL not found: ${aclId}`,
      )
    }
    return meta
  }
}
