import { z } from 'zod'
import { AclClientError, AclError } from './errors'

// ── Constants ──────────────────────────────────────────────────────────────────

export const MACHINES_SCHEMA_NAME = 'triex.machines' as const
export const MACHINES_SCHEMA_VERSION = 1 as const
export const MACHINE_LABEL_MAX_LENGTH = 120 as const
export const MACHINE_NOTE_MAX_LENGTH = 500 as const

/**
 * The entry `description` that identifies a keyspace's machines document,
 * the same way the locations document is identified by `'locations'`.
 */
export const MACHINES_ENTRY_DESCRIPTION = 'machines' as const

// A normalized 32-byte Sui address. Machine rows are keyed by address, and the
// document deliberately has nowhere to put key material — a bech32
// `suiprivkey…` string can never validate as a row key.
const SUI_ADDRESS_RE = /^0x[0-9a-f]{64}$/

export const MachineAddressSchema = z
  .string()
  .regex(
    SUI_ADDRESS_RE,
    'machine address must be a lowercase 0x-prefixed 32-byte hex Sui address',
  )

// ── Version schemas ────────────────────────────────────────────────────────────
//
// Add a new schema block here whenever the schema version is bumped.
// Keep old schemas forever — they are required as migration inputs.

// v1 (current): address-keyed records of display metadata. The document is
// decoration — authorization is always the on-chain Read set, so nothing here
// is ever load-bearing for access control.
export const MachineRecordSchemaV1 = z.object({
  label: z
    .string()
    .min(1, 'label must not be empty')
    .max(
      MACHINE_LABEL_MAX_LENGTH,
      `label must be ≤ ${MACHINE_LABEL_MAX_LENGTH} characters`,
    ),
  /** Wallet address that added (granted) this machine. */
  added_by: MachineAddressSchema,
  /** ISO-8601 timestamp of when the row was added. */
  added_at: z.string(),
  note: z
    .string()
    .max(
      MACHINE_NOTE_MAX_LENGTH,
      `note must be ≤ ${MACHINE_NOTE_MAX_LENGTH} characters`,
    )
    .optional(),
})

export const MachinesDocumentSchemaV1 = z.object({
  schema: z.literal(MACHINES_SCHEMA_NAME),
  schema_version: z.literal(1),
  updated_at: z.string(),
  machines: z.record(MachineAddressSchema, MachineRecordSchemaV1),
})

export type MachineRecord = z.infer<typeof MachineRecordSchemaV1>
export type MachinesDocument = z.infer<typeof MachinesDocumentSchemaV1>

/** Caller-supplied fields for an upsert; added_by/added_at are managed. */
export interface MachineRecordInput {
  label: string
  note?: string
}

// ── Validation & migration ─────────────────────────────────────────────────────

export function validateMachineRecord(record: unknown): MachineRecord {
  const result = MachineRecordSchemaV1.safeParse(record)
  if (!result.success) {
    throw new AclClientError(
      AclError.ValidationFailed,
      `Invalid machine record: ${result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    )
  }
  return result.data
}

/**
 * Normalize a machine address for use as a document key: lowercase hex,
 * validated against the Sui address shape.
 */
export function normalizeMachineAddress(address: string): string {
  const normalized = address.toLowerCase()
  const result = MachineAddressSchema.safeParse(normalized)
  if (!result.success) {
    throw new AclClientError(
      AclError.ValidationFailed,
      `Invalid machine address: "${address}"`,
    )
  }
  return result.data
}

/**
 * Parse a stored machines document, migrating older schema versions to the
 * current one. v1 is the only version so far; the migration ladder mirrors
 * `migrateDocument` in locations-schemas.ts.
 */
export function migrateMachinesDocument(raw: unknown): MachinesDocument {
  const v1 = MachinesDocumentSchemaV1.safeParse(raw)
  if (v1.success) return v1.data

  throw new AclClientError(
    AclError.ValidationFailed,
    `Unrecognized machines document: ${v1.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')}`,
  )
}
