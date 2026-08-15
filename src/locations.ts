import type { AclClient } from './AclClient'
import type { SignPersonalMessageFn, WriteResult, RotateResult } from './types'
import { AclClientError, AclError } from './errors'
import {
  LOCATIONS_SCHEMA_NAME,
  LOCATIONS_SCHEMA_VERSION,
  WARP_IN_MAX_LENGTH,
  TRANSPONDER_CODE_MAX_LENGTH,
  DESTINATION_UNKNOWN,
  type TransponderSetting,
  type StructureType,
  type Location,
  type LocationsDocument,
  type LocationUpdate,
  migrateDocument,
  validateLocation,
} from './locations-schemas'

export {
  LOCATIONS_SCHEMA_NAME,
  LOCATIONS_SCHEMA_VERSION,
  WARP_IN_MAX_LENGTH,
  TRANSPONDER_CODE_MAX_LENGTH,
  DESTINATION_UNKNOWN,
  type TransponderSetting,
  type StructureType,
  type Location,
  type LocationsDocument,
  type LocationUpdate,
}

// ── LocationsClient ───────────────────────────────────────────────────────────

export interface LocationsClientConfig {
  aclClient: AclClient
  aclId: string
  entryId: string
  walletAddress: string
  signPersonalMessage: SignPersonalMessageFn
  /** OU object ID — required by keyspace::seal_approve and write operations. */
  ouId: string
}

/**
 * A set of location edits to apply atomically in one `applyEdits` call.
 * Edits are applied in the order remove → update → add (see `applyEdits`), so
 * an id may be removed and re-added within the same batch.
 */
export interface LocationsBatchEdits {
  /** Locations to append. Each id must not already exist once removes/updates are applied. */
  add?: Location[]
  /** In-place edits by id. Each id must exist once removes are applied. */
  update?: { id: string; changes: LocationUpdate }[]
  /** Ids of locations to delete. */
  remove?: string[]
}

/**
 * Collect `ids` into a Set, rejecting any id that appears more than once in the
 * same bucket (`remove` / `update` / `add`) with ACL_VALIDATION_FAILED — the
 * caller almost certainly didn't mean to edit the same location twice in one
 * pass, and silently letting the last one win hides the mistake.
 */
function uniqueIdSet(ids: string[], bucket: string): Set<string> {
  const set = new Set<string>()
  for (const id of ids) {
    if (set.has(id)) {
      throw new AclClientError(
        AclError.ValidationFailed,
        `Location id "${id}" appears more than once in the ${bucket} edits`,
      )
    }
    set.add(id)
  }
  return set
}

export class LocationsClient {
  private readonly acl: AclClient
  private readonly aclId: string
  private readonly entryId: string
  private readonly walletAddress: string
  private readonly signPersonalMessage: SignPersonalMessageFn
  private readonly ouId: string

  constructor(config: LocationsClientConfig) {
    this.acl = config.aclClient
    this.aclId = config.aclId
    this.entryId = config.entryId
    this.walletAddress = config.walletAddress
    this.signPersonalMessage = config.signPersonalMessage
    this.ouId = config.ouId
  }

  /** Download, decrypt, and migrate the locations document to the current version. */
  async download(): Promise<LocationsDocument> {
    const raw = await this.acl.readData({
      aclId: this.aclId,
      entryId: this.entryId,
      walletAddress: this.walletAddress,
      signPersonalMessage: this.signPersonalMessage,
      ouId: this.ouId,
    })

    const text = new TextDecoder().decode(raw)
    return migrateDocument(JSON.parse(text))
  }

  /** Add a new location to the document, re-encrypt, and upload. */
  async addLocation(location: Location): Promise<WriteResult> {
    const validated = validateLocation(location)
    const doc = await this.download()

    const exists = doc.locations.some((l) => l.id === validated.id)
    if (exists) {
      throw new AclClientError(
        AclError.UnexpectedResponse,
        `Location with id "${validated.id}" already exists`,
      )
    }

    doc.locations.push(validated)
    doc.updated_at = new Date().toISOString()

    return this.acl.editData({
      aclId: this.aclId,
      entryId: this.entryId,
      newPlaintext: JSON.stringify(doc, null, 2),
      walletAddress: this.walletAddress,
      signPersonalMessage: this.signPersonalMessage,
      ouId: this.ouId,
    })
  }

  /** Update an existing location by id, re-encrypt, and upload. */
  async updateLocation(
    id: string,
    updates: LocationUpdate,
  ): Promise<WriteResult> {
    const doc = await this.download()

    const idx = doc.locations.findIndex((l) => l.id === id)
    if (idx === -1) {
      throw new AclClientError(
        AclError.UnexpectedResponse,
        `Location with id "${id}" not found`,
      )
    }

    // Merging two differently-discriminated unions can't type-check as a
    // single Location — validateLocation() is the actual source of truth,
    // catching e.g. a structure_type switch to 'catapult' that didn't also
    // supply destination_solar_system.
    const merged = { ...doc.locations[idx], ...updates }
    doc.locations[idx] = validateLocation(merged)
    doc.updated_at = new Date().toISOString()

    return this.acl.editData({
      aclId: this.aclId,
      entryId: this.entryId,
      newPlaintext: JSON.stringify(doc, null, 2),
      walletAddress: this.walletAddress,
      signPersonalMessage: this.signPersonalMessage,
      ouId: this.ouId,
    })
  }

  /** Remove a location by id, re-encrypt, and upload. */
  async removeLocation(id: string): Promise<WriteResult> {
    const doc = await this.download()

    const idx = doc.locations.findIndex((l) => l.id === id)
    if (idx === -1) {
      throw new AclClientError(
        AclError.UnexpectedResponse,
        `Location with id "${id}" not found`,
      )
    }

    doc.locations.splice(idx, 1)
    doc.updated_at = new Date().toISOString()

    return this.acl.editData({
      aclId: this.aclId,
      entryId: this.entryId,
      newPlaintext: JSON.stringify(doc, null, 2),
      walletAddress: this.walletAddress,
      signPersonalMessage: this.signPersonalMessage,
      ouId: this.ouId,
    })
  }

  /**
   * Apply many location edits in a single download → validate → re-encrypt →
   * upload → on-chain update cycle.
   *
   * Calling `addLocation` / `updateLocation` / `removeLocation` N times costs N
   * of everything — N decrypts, N re-encrypts, N uploads, and N wallet-approved
   * transactions. It also risks building each edit on a document fetched before
   * the previous edit's on-chain pointer has propagated. `applyEdits` collapses
   * a whole set of changes into one document read and one write, so the user
   * approves a single transaction.
   *
   * Edits apply in a fixed order — **remove, then update, then add** — so an id
   * can be removed and re-added in the same batch, and updates target the
   * post-removal set. The input is validated in two phases:
   *
   *   1. Before the download (no network cost): every `add` is shape-checked,
   *      and ids are checked for conflicts. An id repeated within one bucket, an
   *      id in both `remove` and `update`, or an id in both `update` and `add`
   *      throws ACL_VALIDATION_FAILED — these are contradictions, not edits.
   *      (`remove` + `add` of the same id is allowed: it re-adds the location.)
   *   2. Against the downloaded document:
   *      - `remove` / `update` id not present  → ACL_ENTRY_NOT_FOUND
   *      - `update` produces an invalid record → ACL_VALIDATION_FAILED
   *      - `add` id already present            → ACL_VALIDATION_FAILED
   *
   * The whole batch is validated in memory before anything is uploaded or sent
   * on-chain, so a single bad edit rejects the entire call and the stored
   * document is never left half-applied. Passing no edits throws
   * ACL_VALIDATION_FAILED rather than issuing an empty write.
   */
  async applyEdits(edits: LocationsBatchEdits): Promise<WriteResult> {
    const removeIds = edits.remove ?? []
    const updates = edits.update ?? []
    const additions = edits.add ?? []

    if (
      removeIds.length === 0 &&
      updates.length === 0 &&
      additions.length === 0
    ) {
      throw new AclClientError(
        AclError.ValidationFailed,
        'applyEdits called with no edits — pass at least one add, update, or remove',
      )
    }

    // Phase 1: validate the input before paying for a decrypt. validateLocation
    // is pure, so a malformed `add` fails fast without a network round-trip.
    const validatedAdditions = additions.map((loc) => validateLocation(loc))

    const removeSet = uniqueIdSet(removeIds, 'remove')
    const updateSet = uniqueIdSet(
      updates.map((u) => u.id),
      'update',
    )
    const addSet = uniqueIdSet(
      validatedAdditions.map((l) => l.id),
      'add',
    )
    for (const id of updateSet) {
      if (removeSet.has(id)) {
        throw new AclClientError(
          AclError.ValidationFailed,
          `Location id "${id}" cannot be both removed and updated in one batch`,
        )
      }
    }
    for (const id of addSet) {
      if (updateSet.has(id)) {
        throw new AclClientError(
          AclError.ValidationFailed,
          `Location id "${id}" cannot be both updated and added in one batch`,
        )
      }
      // `remove` + `add` of the same id is intentional — it re-adds the record.
    }

    // Phase 2: apply against the current document. Index by id once so the
    // whole batch is O(n + edits) rather than O(n × edits).
    const doc = await this.download()
    const byId = new Map(doc.locations.map((l) => [l.id, l]))

    // Removes — Map.delete reports whether the id existed.
    for (const id of removeIds) {
      if (!byId.delete(id)) {
        throw new AclClientError(
          AclError.EntryNotFound,
          `Location with id "${id}" not found`,
        )
      }
    }

    // Updates — merge + validate each surviving id (must exist). Re-setting an
    // existing key keeps its position in the document.
    for (const { id, changes } of updates) {
      const current = byId.get(id)
      if (!current) {
        throw new AclClientError(
          AclError.EntryNotFound,
          `Location with id "${id}" not found`,
        )
      }
      // See updateLocation — validateLocation is the source of truth for a
      // merge across differently-discriminated unions.
      byId.set(id, validateLocation({ ...current, ...changes }))
    }

    // Adds — must not collide with a location that survived the removes.
    for (const location of validatedAdditions) {
      if (byId.has(location.id)) {
        throw new AclClientError(
          AclError.ValidationFailed,
          `Location with id "${location.id}" already exists`,
        )
      }
      byId.set(location.id, location)
    }

    doc.locations = [...byId.values()]
    doc.updated_at = new Date().toISOString()

    return this.acl.editData({
      aclId: this.aclId,
      entryId: this.entryId,
      newPlaintext: JSON.stringify(doc, null, 2),
      walletAddress: this.walletAddress,
      signPersonalMessage: this.signPersonalMessage,
      ouId: this.ouId,
    })
  }

  /**
   * Re-encrypt the entire locations document under the current keyspace epoch.
   * Use after Read membership changes to revoke access for removed principals.
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

  // ── Static factory ──────────────────────────────────────────────────────────

  /** Create a brand-new locations entry on-chain with an empty document. */
  static async create(opts: {
    aclClient: AclClient
    aclId: string
    walletAddress: string
    signPersonalMessage: SignPersonalMessageFn
    ouId: string
  }): Promise<LocationsClient> {
    const doc: LocationsDocument = {
      schema: LOCATIONS_SCHEMA_NAME,
      schema_version: LOCATIONS_SCHEMA_VERSION,
      updated_at: new Date().toISOString(),
      locations: [],
    }

    const result = await opts.aclClient.writeData({
      aclId: opts.aclId,
      plaintext: JSON.stringify(doc, null, 2),
      description: 'locations',
      walletAddress: opts.walletAddress,
      signPersonalMessage: opts.signPersonalMessage,
      ouId: opts.ouId,
    })

    return new LocationsClient({
      aclClient: opts.aclClient,
      aclId: opts.aclId,
      entryId: result.entryId,
      walletAddress: opts.walletAddress,
      signPersonalMessage: opts.signPersonalMessage,
      ouId: opts.ouId,
    })
  }
}
