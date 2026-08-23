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
  StorageAdapter,
  TransactionExecutor,
  WriteResult,
} from './types'
import { Transaction } from '@mysten/sui/transactions'
import { AclClientError, AclError } from './errors'
import {
  addMigrateAclToV2Call,
  createKeyspaceTx,
  createKeyspaceForOuTx,
  editDescriptionTx,
  editEntryTx,
  grantTx,
  grantV2Tx,
  migrateAclToV2Tx,
  publishEntryTx,
  revokeTx,
  revokeV2Tx,
  updateEntryTx,
} from './transactions'
import {
  fetchAccessibleKeyspaces,
  fetchEncryptedEntry,
  fetchKeyspaceDetail,
  fetchKeyspaceMeta,
  fetchPrincipalRoleMapV2,
} from './queries'
import { sealDecrypt, sealEncrypt } from './seal_helpers'
import { downloadBlob, DEFAULT_IPFS_GATEWAY } from './storage'

/** Default indexer: the Trinary Exchange gateway. */
const DEFAULT_INDEXER_URL = 'https://api.trinary.exchange'

/**
 * Default armature_vault package id (testnet). This is the *original* (v1)
 * published id: Seal derives its decryption identity from it and it stays
 * stable across package upgrades, so it is a safe default for both the
 * `seal_approve` and on-chain call paths. Override `packageId` for mainnet or
 * any non-default deployment.
 */
export const DEFAULT_PACKAGE_ID =
  '0x3af6edb64f575cb65a89f1c8f445a2e2aad05324a1586aad9e2651191bf4f99b'

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
  private readonly ipfsGateway: string
  private readonly preferAdapterDownload: boolean
  private readonly autoMigrateAcl: boolean
  /**
   * Keyspaces this client has already carried a migration prelude for (or found
   * nothing to migrate in). Bounds the prelude to one attempt per keyspace per
   * client, so steady-state mutations pay nothing. Not persisted — a fresh
   * client retries once, which is harmless because the migration is idempotent
   * on-chain.
   */
  private readonly migratedAcls = new Set<string>()

  constructor(config: AclClientConfig) {
    this.suiClient = config.suiClient
    this.sealClient = config.sealClient
    this.packageId = config.packageId ?? DEFAULT_PACKAGE_ID
    this.executor = config.executor
    this.storageAdapter = config.storageAdapter
    this.defaultOuId = config.ouId
    this.indexerUrl = config.indexerUrl ?? DEFAULT_INDEXER_URL
    this.apiKey = config.apiKey
    this.sessionKeyTtlMin = config.sessionKeyTtlMin ?? 10
    this.ipfsGateway = config.ipfsGateway ?? DEFAULT_IPFS_GATEWAY
    this.preferAdapterDownload = config.preferAdapterDownload ?? false
    this.autoMigrateAcl = config.autoMigrateAcl ?? false
  }

  /**
   * Fetch an entry's encrypted bytes from its on-chain `uri`, independent of
   * which storage adapter wrote it. By default this resolves the `uri`
   * generically (scheme-routed fetch + format sniffing) and only falls back to
   * `storageAdapter.download` when that fails — so a reader with a mismatched
   * or minimal adapter can still read any publicly fetchable blob. Private,
   * auth-gated backends are reached via the adapter fallback (or, if you know
   * every blob is private, set `preferAdapterDownload` to skip the probe).
   */
  private async resolveBlob(uri: string): Promise<Uint8Array> {
    const generic = (): Promise<Uint8Array> =>
      downloadBlob(uri, { ipfsGateway: this.ipfsGateway })
    const adapter = this.storageAdapter
    const viaAdapter = adapter
      ? (): Promise<Uint8Array> => adapter.download(uri)
      : null

    // Generic (adapter-independent) resolver first, the adapter as the
    // private-backend fallback; `preferAdapterDownload` flips the order. With
    // no adapter configured, only the generic resolver runs.
    const steps =
      this.preferAdapterDownload && viaAdapter
        ? [viaAdapter, generic]
        : viaAdapter
          ? [generic, viaAdapter]
          : [generic]

    // Surface the first (primary-path) error if every step fails.
    let firstErr: unknown
    for (const step of steps) {
      try {
        return await step()
      } catch (err) {
        if (firstErr === undefined) firstErr = err
      }
    }
    throw firstErr
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

  private requireExecutor(): TransactionExecutor {
    if (!this.executor) {
      throw new AclClientError(
        AclError.ExecutorRequired,
        'This operation submits an on-chain transaction and needs an `executor` in AclClientConfig. A read/decrypt-only client can omit it.',
      )
    }
    return this.executor
  }

  // ── Auto-migration to the v2 principal store ────────────────────────────────
  //
  // See `autoMigrateAcl` in AclClientConfig for the full contract. The prelude
  // rides on the mutation's own PTB and must be added BEFORE the operation's
  // moveCall, since after it runs the v1 lists are empty and anything later in
  // the same transaction has to target v2.

  /**
   * Start a PTB for a mutation on `aclId`, carrying the migration prelude when
   * auto-migration is on and this keyspace hasn't been handled yet. Returns the
   * transaction plus whether the prelude was added — callers use that to route
   * to the v2 entry points and to update the cache after execution.
   */
  private beginMutation(
    aclId: string,
    ouId: string,
  ): { tx: Transaction; migrating: boolean } {
    const tx = new Transaction()
    if (!this.autoMigrateAcl || this.migratedAcls.has(aclId)) {
      return { tx, migrating: false }
    }
    addMigrateAclToV2Call(tx, this.packageId, aclId, ouId)
    return { tx, migrating: true }
  }

  /**
   * True when `address` satisfies the `Grant` role — the precondition
   * `migrate_acl_to_v2` enforces. Reads the merged role set, so a grantor in
   * either ACL store counts, exactly as the contract's `satisfies_role` does.
   * Used to decide whether an entry write can safely carry the prelude.
   */
  private async holdsGrant(
    aclId: string,
    address: string,
    ouId: string,
  ): Promise<boolean> {
    try {
      const detail = await this.getAcl(aclId)
      return detail.grantPrincipals.some((p) =>
        p.type === 'ou' ? p.ouId === ouId : p.address === address,
      )
    } catch {
      // A failed probe must not break the write it was only trying to
      // piggyback on — skip the prelude and let the mutation proceed alone.
      return false
    }
  }

  /**
   * Same as {@link beginMutation}, but for operations whose caller only needs
   * `Write`: the prelude is added only if `address` also holds `Grant`.
   */
  private async beginEntryMutation(
    aclId: string,
    ouId: string,
    address: string,
  ): Promise<{ tx: Transaction; migrating: boolean }> {
    if (!this.autoMigrateAcl || this.migratedAcls.has(aclId)) {
      return { tx: new Transaction(), migrating: false }
    }
    if (!(await this.holdsGrant(aclId, address, ouId))) {
      return { tx: new Transaction(), migrating: false }
    }
    return this.beginMutation(aclId, ouId)
  }

  private requireStorageAdapter(): StorageAdapter {
    if (!this.storageAdapter) {
      throw new AclClientError(
        AclError.StorageAdapterRequired,
        'This operation uploads an encrypted blob and needs a `storageAdapter` in AclClientConfig. Reads resolve blobs without one.',
      )
    }
    return this.storageAdapter
  }

  // ── Keyspace lifecycle ──────────────────────────────────────────────────────

  async createAcl(opts: { name: string }): Promise<CreateAclResult> {
    const tx = createKeyspaceTx(this.packageId, opts.name)
    const result = await this.requireExecutor()(tx)
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
    const result = await this.requireExecutor()(tx)
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
   *
   * `player` and `ou` principals go to the original (v1) ACL, preserving
   * existing behavior. `machine` — and any kind added after it — exists only
   * in the upgradeable v2 ACL, so it routes to `keyspace::grant_v2` and
   * requires a v3+ armature_vault deployment; against older deployments the
   * transaction fails at execution with an unresolved-function error.
   * Pass `v2: true` to put a player/ou grant in the v2 store instead.
   *
   * With `autoMigrateAcl` on, this call also carries the migration prelude and
   * every grant targets v2 — after the migration in the same PTB there is no
   * v1 list left to add to. That takes precedence over `v2: false`, which would
   * otherwise re-populate the store the migration just drained.
   */
  async grant(opts: {
    aclId: string
    keyspaceRole: KeyspaceRole
    principal: Principal
    ouId?: string
    v2?: boolean
  }): Promise<{ epoch: number }> {
    const ouId = this.requireOuId(opts.ouId)
    const { tx: baseTx, migrating } = this.beginMutation(opts.aclId, ouId)
    const useV2 =
      migrating ||
      this.autoMigrateAcl ||
      opts.v2 === true ||
      opts.principal.type === 'machine'
    const build = useV2 ? grantV2Tx : grantTx
    const tx = build(
      this.packageId,
      opts.aclId,
      ouId,
      opts.keyspaceRole,
      opts.principal,
      baseTx,
    )
    await this.requireExecutor()(tx)
    if (migrating) this.migratedAcls.add(opts.aclId)
    const meta = await this.getAclMeta(opts.aclId)
    return { epoch: meta.epoch }
  }

  /**
   * Revoke `principal` from `keyspaceRole` on `aclId`.
   * Caller must hold the Grant role.
   *
   * A principal must be revoked from the store it was granted in, and
   * `migrate_acl_to_v2` moves player/ou principals from v1 to v2 — so unless
   * `v2` is given explicitly, this probes the v2 store (one extra read) and
   * targets whichever store actually holds the principal. Machine principals
   * skip the probe: they can only ever live in v2.
   *
   * With `autoMigrateAcl` on the probe is skipped entirely and the revoke
   * always targets v2 — taking precedence over `v2`, since either this PTB's
   * own prelude just moved the principal there or an earlier mutation already
   * did. That also removes a read from the hot path.
   */
  async revoke(opts: {
    aclId: string
    keyspaceRole: KeyspaceRole
    principal: Principal
    ouId?: string
    v2?: boolean
  }): Promise<{ epoch: number }> {
    const ouId = this.requireOuId(opts.ouId)
    const { tx: baseTx, migrating } = this.beginMutation(opts.aclId, ouId)
    const useV2 = this.autoMigrateAcl
      ? true
      : (opts.v2 ??
        (await this.holdsInV2(opts.aclId, opts.keyspaceRole, opts.principal)))
    const build = useV2 ? revokeV2Tx : revokeTx
    const tx = build(
      this.packageId,
      opts.aclId,
      ouId,
      opts.keyspaceRole,
      opts.principal,
      baseTx,
    )
    await this.requireExecutor()(tx)
    if (migrating) this.migratedAcls.add(opts.aclId)
    const meta = await this.getAclMeta(opts.aclId)
    return { epoch: meta.epoch }
  }

  /**
   * Lift this keyspace's v1 principals into the v2 store. Caller must hold
   * Grant. Access-neutral and idempotent — but it empties the object's `acl`
   * field, which SDKs older than this major read directly, so only migrate
   * once your consumers are upgraded.
   */
  async migrateAclToV2(opts: {
    aclId: string
    ouId?: string
  }): Promise<{ epoch: number }> {
    const ouId = this.requireOuId(opts.ouId)
    const tx = migrateAclToV2Tx(this.packageId, opts.aclId, ouId)
    await this.requireExecutor()(tx)
    // Nothing left for an auto-migration prelude to do on this keyspace.
    this.migratedAcls.add(opts.aclId)
    const meta = await this.getAclMeta(opts.aclId)
    return { epoch: meta.epoch }
  }

  /** True when the v2 store holds this exact principal for `role`. */
  private async holdsInV2(
    aclId: string,
    role: KeyspaceRole,
    principal: Principal,
  ): Promise<boolean> {
    if (principal.type === 'machine') return true
    const v2 = await fetchPrincipalRoleMapV2(this.suiClient, aclId)
    const list =
      role === 'Grant' ? v2.grant : role === 'Read' ? v2.read : v2.write
    return list.some(
      (p) =>
        p.type === principal.type &&
        (p.type === 'ou'
          ? p.ouId === (principal as { ouId: string }).ouId
          : p.address === (principal as { address: string }).address),
    )
  }

  /**
   * Returns true if `address` holds Read access either directly as a player or
   * machine principal, or indirectly via an OU principal whose `ouId` is
   * supplied. Pass `ouId` to check OU membership; omit to check direct
   * (player/machine) membership only.
   */
  async hasAccess(opts: {
    aclId: string
    address: string
    ouId?: string
  }): Promise<boolean> {
    const acl = await this.getAcl(opts.aclId)
    return acl.readPrincipals.some(
      (p) =>
        ((p.type === 'player' || p.type === 'machine') &&
          p.address === opts.address) ||
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
    await this.requireExecutor()(tx)
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

    const uri = await this.requireStorageAdapter().upload(encrypted)

    const { tx: baseTx, migrating } = await this.beginEntryMutation(
      opts.aclId,
      ouId,
      opts.walletAddress,
    )
    const tx = publishEntryTx(
      this.packageId,
      opts.aclId,
      ouId,
      uri,
      opts.description,
      baseTx,
    )
    const result = await this.requireExecutor()(tx)
    if (migrating) this.migratedAcls.add(opts.aclId)

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

    const encrypted = await this.resolveBlob(entry.uri)

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

    const uri = await this.requireStorageAdapter().upload(encrypted)

    const { tx: baseTx, migrating } = await this.beginEntryMutation(
      opts.aclId,
      ouId,
      opts.walletAddress,
    )
    const tx = editEntryTx(
      this.packageId,
      opts.aclId,
      opts.entryId,
      ouId,
      uri,
      baseTx,
    )
    await this.requireExecutor()(tx)
    if (migrating) this.migratedAcls.add(opts.aclId)

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

    const newUri = await this.requireStorageAdapter().upload(encrypted)

    const { tx: baseTx, migrating } = await this.beginEntryMutation(
      opts.aclId,
      ouId,
      opts.walletAddress,
    )
    const tx = updateEntryTx(
      this.packageId,
      opts.aclId,
      opts.entryId,
      ouId,
      newUri,
      baseTx,
    )
    await this.requireExecutor()(tx)
    if (migrating) this.migratedAcls.add(opts.aclId)

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
   * Returns true if `address` holds Read access either directly as a player or
   * machine principal, or indirectly via an OU principal whose `ouId` is
   * supplied. Pass `ouId` to check OU membership; omit to check direct
   * (player/machine) membership only.
   */
  async hasAccess(opts: {
    aclId: string
    address: string
    ouId?: string
  }): Promise<boolean> {
    const acl = await this.getAcl(opts.aclId)
    return acl.readPrincipals.some(
      (p) =>
        ((p.type === 'player' || p.type === 'machine') &&
          p.address === opts.address) ||
        (p.type === 'ou' && opts.ouId !== undefined && p.ouId === opts.ouId),
    )
  }

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
