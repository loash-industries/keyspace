import type { AclClient } from './AclClient'
import type { SignPersonalMessageFn, WriteResult, RotateResult } from './types'
import { AclClientError, AclError } from './errors'
import {
  LOCATIONS_SCHEMA_NAME,
  LOCATIONS_SCHEMA_VERSION,
  WARP_IN_MAX_LENGTH,
  type Location,
  type LocationsDocument,
  migrateDocument,
  validateLocation,
} from './locations-schemas'

export {
  LOCATIONS_SCHEMA_NAME,
  LOCATIONS_SCHEMA_VERSION,
  WARP_IN_MAX_LENGTH,
  type Location,
  type LocationsDocument,
}

// ── LocationsClient ───────────────────────────────────────────────────────────

export interface LocationsClientConfig {
  aclClient: AclClient
  aclId: string
  entryId: string
  walletAddress: string
  signPersonalMessage: SignPersonalMessageFn
  /** DAO object ID — required by keyspace::seal_approve and write operations. */
  daoId: string
}

export class LocationsClient {
  private readonly acl: AclClient
  private readonly aclId: string
  private readonly entryId: string
  private readonly walletAddress: string
  private readonly signPersonalMessage: SignPersonalMessageFn
  private readonly daoId: string

  constructor(config: LocationsClientConfig) {
    this.acl = config.aclClient
    this.aclId = config.aclId
    this.entryId = config.entryId
    this.walletAddress = config.walletAddress
    this.signPersonalMessage = config.signPersonalMessage
    this.daoId = config.daoId
  }

  /** Download, decrypt, and migrate the locations document to the current version. */
  async download(): Promise<LocationsDocument> {
    const raw = await this.acl.readData({
      aclId: this.aclId,
      entryId: this.entryId,
      walletAddress: this.walletAddress,
      signPersonalMessage: this.signPersonalMessage,
      daoId: this.daoId,
    })

    const text = new TextDecoder().decode(raw)
    return migrateDocument(JSON.parse(text))
  }

  /** Add a new location to the document, re-encrypt, and upload. */
  async addLocation(location: Location): Promise<WriteResult> {
    validateLocation(location)
    const doc = await this.download()

    const exists = doc.locations.some((l) => l.id === location.id)
    if (exists) {
      throw new AclClientError(
        AclError.UnexpectedResponse,
        `Location with id "${location.id}" already exists`,
      )
    }

    doc.locations.push(location)
    doc.updated_at = new Date().toISOString()

    return this.acl.editData({
      aclId: this.aclId,
      entryId: this.entryId,
      newPlaintext: JSON.stringify(doc, null, 2),
      walletAddress: this.walletAddress,
      signPersonalMessage: this.signPersonalMessage,
      daoId: this.daoId,
    })
  }

  /** Update an existing location by id, re-encrypt, and upload. */
  async updateLocation(
    id: string,
    updates: Partial<Omit<Location, 'id'>>,
  ): Promise<WriteResult> {
    const doc = await this.download()

    const idx = doc.locations.findIndex((l) => l.id === id)
    if (idx === -1) {
      throw new AclClientError(
        AclError.UnexpectedResponse,
        `Location with id "${id}" not found`,
      )
    }

    const merged = { ...doc.locations[idx], ...updates }
    validateLocation(merged)
    doc.locations[idx] = merged
    doc.updated_at = new Date().toISOString()

    return this.acl.editData({
      aclId: this.aclId,
      entryId: this.entryId,
      newPlaintext: JSON.stringify(doc, null, 2),
      walletAddress: this.walletAddress,
      signPersonalMessage: this.signPersonalMessage,
      daoId: this.daoId,
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
      daoId: this.daoId,
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
      daoId: this.daoId,
    })
  }

  // ── Static factory ──────────────────────────────────────────────────────────

  /** Create a brand-new locations entry on-chain with an empty document. */
  static async create(opts: {
    aclClient: AclClient
    aclId: string
    walletAddress: string
    signPersonalMessage: SignPersonalMessageFn
    daoId: string
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
      daoId: opts.daoId,
    })

    return new LocationsClient({
      aclClient: opts.aclClient,
      aclId: opts.aclId,
      entryId: result.entryId,
      walletAddress: opts.walletAddress,
      signPersonalMessage: opts.signPersonalMessage,
      daoId: opts.daoId,
    })
  }
}
