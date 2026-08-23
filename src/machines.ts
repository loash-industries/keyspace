import type { AclClient } from './AclClient'
import type { SignPersonalMessageFn, WriteResult, RotateResult } from './types'
import { AclClientError, AclError } from './errors'
import {
  MACHINES_SCHEMA_NAME,
  MACHINES_SCHEMA_VERSION,
  MACHINES_ENTRY_DESCRIPTION,
  MACHINE_LABEL_MAX_LENGTH,
  MACHINE_NOTE_MAX_LENGTH,
  type MachineRecord,
  type MachineRecordInput,
  type MachinesDocument,
  migrateMachinesDocument,
  normalizeMachineAddress,
  validateMachineRecord,
} from './machines-schemas'

export {
  MACHINES_SCHEMA_NAME,
  MACHINES_SCHEMA_VERSION,
  MACHINES_ENTRY_DESCRIPTION,
  MACHINE_LABEL_MAX_LENGTH,
  MACHINE_NOTE_MAX_LENGTH,
  type MachineRecord,
  type MachineRecordInput,
  type MachinesDocument,
}

// ── MachinesClient ────────────────────────────────────────────────────────────
//
// Wraps a keyspace's `machines` entry: an encrypted, versioned JSON document
// mapping machine addresses (server-held keypairs granted as
// `{ type: 'machine' }` principals) to display metadata — label, who added it,
// when, and an optional note.
//
// The document is decoration, never authorization: the on-chain Read set is
// the source of truth for access, and rows can drift from it (a row whose
// grant was revoked, a grant added without a row). Render principals from the
// chain, attach labels when a row matches, and treat orphan rows as cleanup
// hints. The document holds addresses and metadata only — key material has no
// field to land in.

export interface MachinesClientConfig {
  aclClient: AclClient
  aclId: string
  entryId: string
  walletAddress: string
  signPersonalMessage: SignPersonalMessageFn
  /** OU object ID — required by keyspace::seal_approve and write operations. */
  ouId: string
}

export class MachinesClient {
  private readonly acl: AclClient
  private readonly aclId: string
  private readonly entryId: string
  private readonly walletAddress: string
  private readonly signPersonalMessage: SignPersonalMessageFn
  private readonly ouId: string

  constructor(config: MachinesClientConfig) {
    this.acl = config.aclClient
    this.aclId = config.aclId
    this.entryId = config.entryId
    this.walletAddress = config.walletAddress
    this.signPersonalMessage = config.signPersonalMessage
    this.ouId = config.ouId
  }

  /** Download, decrypt, and migrate the machines document to the current version. */
  async download(): Promise<MachinesDocument> {
    const raw = await this.acl.readData({
      aclId: this.aclId,
      entryId: this.entryId,
      walletAddress: this.walletAddress,
      signPersonalMessage: this.signPersonalMessage,
      ouId: this.ouId,
    })

    const text = new TextDecoder().decode(raw)
    return migrateMachinesDocument(JSON.parse(text))
  }

  /**
   * Add or update the row for `address`, re-encrypt, and upload.
   *
   * On update, `added_by`/`added_at` are preserved from the existing row; on
   * insert they are set to this client's wallet and the current time. Callers
   * only ever supply display fields (`label`, `note`).
   */
  async upsert(
    address: string,
    input: MachineRecordInput,
  ): Promise<WriteResult> {
    const key = normalizeMachineAddress(address)
    const doc = await this.download()

    const existing = doc.machines[key]
    const record: MachineRecord = validateMachineRecord({
      label: input.label,
      note: input.note,
      added_by:
        existing?.added_by ?? normalizeMachineAddress(this.walletAddress),
      added_at: existing?.added_at ?? new Date().toISOString(),
    })

    doc.machines[key] = record
    doc.updated_at = new Date().toISOString()

    return this.writeDocument(doc)
  }

  /** Remove the row for `address`, re-encrypt, and upload. */
  async remove(address: string): Promise<WriteResult> {
    const key = normalizeMachineAddress(address)
    const doc = await this.download()

    if (!doc.machines[key]) {
      throw new AclClientError(
        AclError.EntryNotFound,
        `Machine "${key}" not found in machines document`,
      )
    }

    delete doc.machines[key]
    doc.updated_at = new Date().toISOString()

    return this.writeDocument(doc)
  }

  /**
   * Re-encrypt the machines document under the current keyspace epoch.
   * Use after Read membership changes, alongside the other entries' rotation.
   */
  async reencrypt(): Promise<RotateResult> {
    return this.acl.rotateEntry({
      aclId: this.aclId,
      entryId: this.entryId,
      walletAddress: this.walletAddress,
      signPersonalMessage: this.signPersonalMessage,
      ouId: this.ouId,
    })
  }

  private writeDocument(doc: MachinesDocument): Promise<WriteResult> {
    return this.acl.editData({
      aclId: this.aclId,
      entryId: this.entryId,
      newPlaintext: JSON.stringify(doc, null, 2),
      walletAddress: this.walletAddress,
      signPersonalMessage: this.signPersonalMessage,
      ouId: this.ouId,
    })
  }

  // ── Static factories ────────────────────────────────────────────────────────

  /**
   * Open the keyspace's existing machines entry, identified by its entry
   * description (`'machines'`). Returns null when the keyspace has none —
   * pair with `create` for the lazy-creation flow:
   *
   * ```ts
   * const machines =
   *   (await MachinesClient.open(opts)) ?? (await MachinesClient.create(opts))
   * ```
   */
  static async open(opts: {
    aclClient: AclClient
    aclId: string
    walletAddress: string
    signPersonalMessage: SignPersonalMessageFn
    ouId: string
  }): Promise<MachinesClient | null> {
    const detail = await opts.aclClient.getAcl(opts.aclId)
    const entry = detail.entries.find(
      (e) => e.description === MACHINES_ENTRY_DESCRIPTION,
    )
    if (!entry) return null

    return new MachinesClient({
      aclClient: opts.aclClient,
      aclId: opts.aclId,
      entryId: entry.id,
      walletAddress: opts.walletAddress,
      signPersonalMessage: opts.signPersonalMessage,
      ouId: opts.ouId,
    })
  }

  /** Create a brand-new machines entry on-chain with an empty document. */
  static async create(opts: {
    aclClient: AclClient
    aclId: string
    walletAddress: string
    signPersonalMessage: SignPersonalMessageFn
    ouId: string
  }): Promise<MachinesClient> {
    const doc: MachinesDocument = {
      schema: MACHINES_SCHEMA_NAME,
      schema_version: MACHINES_SCHEMA_VERSION,
      updated_at: new Date().toISOString(),
      machines: {},
    }

    const result = await opts.aclClient.writeData({
      aclId: opts.aclId,
      plaintext: JSON.stringify(doc, null, 2),
      description: MACHINES_ENTRY_DESCRIPTION,
      walletAddress: opts.walletAddress,
      signPersonalMessage: opts.signPersonalMessage,
      ouId: opts.ouId,
    })

    return new MachinesClient({
      aclClient: opts.aclClient,
      aclId: opts.aclId,
      entryId: result.entryId,
      walletAddress: opts.walletAddress,
      signPersonalMessage: opts.signPersonalMessage,
      ouId: opts.ouId,
    })
  }
}
