import type { AclClient } from './AclClient';
import type { SignPersonalMessageFn, WriteResult, RotateResult } from './types';
import { AclClientError, AclError } from './errors';

// ── Location schema ───────────────────────────────────────────────────────────

export const LOCATIONS_SCHEMA_NAME = 'triex.locations' as const;
export const LOCATIONS_SCHEMA_VERSION = 1 as const;

export interface Location {
  solar_system: string;
  warp_in: string;
  description: string;
  id: string;
}

export interface LocationsDocument {
  schema: typeof LOCATIONS_SCHEMA_NAME;
  schema_version: typeof LOCATIONS_SCHEMA_VERSION;
  updated_at: string;
  locations: Location[];
}

// ── LocationsClient ───────────────────────────────────────────────────────────

export interface LocationsClientConfig {
  aclClient: AclClient;
  aclId: string;
  entryId: string;
  walletAddress: string;
  signPersonalMessage: SignPersonalMessageFn;
}

export class LocationsClient {
  private readonly acl: AclClient;
  private readonly aclId: string;
  private readonly entryId: string;
  private readonly walletAddress: string;
  private readonly signPersonalMessage: SignPersonalMessageFn;

  constructor(config: LocationsClientConfig) {
    this.acl = config.aclClient;
    this.aclId = config.aclId;
    this.entryId = config.entryId;
    this.walletAddress = config.walletAddress;
    this.signPersonalMessage = config.signPersonalMessage;
  }

  /**
   * Download and decrypt the existing locations document.
   */
  async download(): Promise<LocationsDocument> {
    const raw = await this.acl.readData({
      aclId: this.aclId,
      entryId: this.entryId,
      walletAddress: this.walletAddress,
      signPersonalMessage: this.signPersonalMessage,
    });

    const text = new TextDecoder().decode(raw);
    const doc = JSON.parse(text) as LocationsDocument;

    if (doc.schema !== LOCATIONS_SCHEMA_NAME) {
      throw new AclClientError(
        AclError.UnexpectedResponse,
        `Unknown schema: expected "${LOCATIONS_SCHEMA_NAME}", got "${doc.schema}"`,
      );
    }
    if (doc.schema_version !== LOCATIONS_SCHEMA_VERSION) {
      throw new AclClientError(
        AclError.UnexpectedResponse,
        `Unsupported schema version: expected ${LOCATIONS_SCHEMA_VERSION}, got ${doc.schema_version}`,
      );
    }

    return doc;
  }

  /**
   * Add a new location to the document, re-encrypt, and upload.
   */
  async addLocation(location: Location): Promise<WriteResult> {
    const doc = await this.download();

    const exists = doc.locations.some((l) => l.id === location.id);
    if (exists) {
      throw new AclClientError(
        AclError.UnexpectedResponse,
        `Location with id "${location.id}" already exists`,
      );
    }

    doc.locations.push(location);
    doc.updated_at = new Date().toISOString();

    return this.acl.editData({
      aclId: this.aclId,
      entryId: this.entryId,
      newPlaintext: JSON.stringify(doc, null, 2),
      walletAddress: this.walletAddress,
      signPersonalMessage: this.signPersonalMessage,
    });
  }

  /**
   * Update an existing location by id, re-encrypt, and upload.
   */
  async updateLocation(
    id: string,
    updates: Partial<Omit<Location, 'id'>>,
  ): Promise<WriteResult> {
    const doc = await this.download();

    const idx = doc.locations.findIndex((l) => l.id === id);
    if (idx === -1) {
      throw new AclClientError(
        AclError.UnexpectedResponse,
        `Location with id "${id}" not found`,
      );
    }

    doc.locations[idx] = { ...doc.locations[idx], ...updates };
    doc.updated_at = new Date().toISOString();

    return this.acl.editData({
      aclId: this.aclId,
      entryId: this.entryId,
      newPlaintext: JSON.stringify(doc, null, 2),
      walletAddress: this.walletAddress,
      signPersonalMessage: this.signPersonalMessage,
    });
  }

  /**
   * Re-encrypt the entire locations document under the current ACL epoch.
   * Use after membership changes to revoke access for removed members.
   */
  async reencrypt(): Promise<RotateResult> {
    return this.acl.rotateEntry({
      aclId: this.aclId,
      entryId: this.entryId,
      walletAddress: this.walletAddress,
      signPersonalMessage: this.signPersonalMessage,
    });
  }

  /**
   * Remove a location by id, re-encrypt, and upload.
   */
  async removeLocation(id: string): Promise<WriteResult> {
    const doc = await this.download();

    const idx = doc.locations.findIndex((l) => l.id === id);
    if (idx === -1) {
      throw new AclClientError(
        AclError.UnexpectedResponse,
        `Location with id "${id}" not found`,
      );
    }

    doc.locations.splice(idx, 1);
    doc.updated_at = new Date().toISOString();

    return this.acl.editData({
      aclId: this.aclId,
      entryId: this.entryId,
      newPlaintext: JSON.stringify(doc, null, 2),
      walletAddress: this.walletAddress,
      signPersonalMessage: this.signPersonalMessage,
    });
  }

  // ── Static factory ──────────────────────────────────────────────────────────

  /**
   * Create a brand-new locations entry on-chain with an empty document.
   */
  static async create(opts: {
    aclClient: AclClient;
    aclId: string;
    walletAddress: string;
    signPersonalMessage: SignPersonalMessageFn;
  }): Promise<LocationsClient> {
    const doc: LocationsDocument = {
      schema: LOCATIONS_SCHEMA_NAME,
      schema_version: LOCATIONS_SCHEMA_VERSION,
      updated_at: new Date().toISOString(),
      locations: [],
    };

    const result = await opts.aclClient.writeData({
      aclId: opts.aclId,
      plaintext: JSON.stringify(doc, null, 2),
      description: 'locations',
      walletAddress: opts.walletAddress,
      signPersonalMessage: opts.signPersonalMessage,
    });

    return new LocationsClient({
      aclClient: opts.aclClient,
      aclId: opts.aclId,
      entryId: result.entryId,
      walletAddress: opts.walletAddress,
      signPersonalMessage: opts.signPersonalMessage,
    });
  }
}
