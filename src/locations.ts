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
