import { z } from 'zod'
import { AclClientError, AclError } from './errors'

// ── Constants ──────────────────────────────────────────────────────────────────

export const LOCATIONS_SCHEMA_NAME = 'triex.locations' as const
export const LOCATIONS_SCHEMA_VERSION = 2 as const
export const WARP_IN_MAX_LENGTH = 32 as const

// ── Version schemas ────────────────────────────────────────────────────────────
//
// Add a new schema block here whenever the schema version is bumped.
// Keep old schemas forever — they are required as migration inputs.

// v1: warp_in was free-form (PxLx convention assumed, not enforced)
const LocationSchemaV1 = z.object({
  id: z.string(),
  solar_system: z.string(),
  structure_type: z.string(),
  warp_in: z.string(),
  description: z.string(),
})

const DocumentSchemaV1 = z.object({
  schema: z.literal(LOCATIONS_SCHEMA_NAME),
  schema_version: z.literal(1),
  updated_at: z.string(),
  locations: z.array(LocationSchemaV1),
})

// v2 (current): warp_in is any string ≤ 32 characters
export const LocationSchemaV2 = z.object({
  id: z.string(),
  solar_system: z.string(),
  structure_type: z.string(),
  warp_in: z
    .string()
    .max(WARP_IN_MAX_LENGTH, `warp_in must be ≤ ${WARP_IN_MAX_LENGTH} characters`),
  description: z.string(),
})

export const DocumentSchemaV2 = z.object({
  schema: z.literal(LOCATIONS_SCHEMA_NAME),
  schema_version: z.literal(LOCATIONS_SCHEMA_VERSION),
  updated_at: z.string(),
  locations: z.array(LocationSchemaV2),
})

export type Location = z.infer<typeof LocationSchemaV2>
export type LocationsDocument = z.infer<typeof DocumentSchemaV2>

// ── Migration steps ────────────────────────────────────────────────────────────
//
// One entry per version increment, applied in array order.
// Contract:
//   inputSchema  — validates the document *before* transformation
//   outputSchema — validates the document *after*  transformation
//   migrate      — pure transform; receives the parsed+validated input document

interface MigrationStep {
  fromVersion: number
  toVersion: number
  inputSchema: z.ZodTypeAny
  outputSchema: z.ZodTypeAny
  migrate: (doc: unknown) => unknown
}

const MIGRATIONS: MigrationStep[] = [
  {
    // v1 → v2: warp_in relaxed from implicit PxLx to any ≤ 32-char string.
    // Truncate oversized values so pre-existing documents remain valid after upgrade.
    fromVersion: 1,
    toVersion: 2,
    inputSchema: DocumentSchemaV1,
    outputSchema: DocumentSchemaV2,
    migrate: (doc: unknown) => {
      const v1 = doc as z.infer<typeof DocumentSchemaV1>
      return {
        ...v1,
        schema_version: 2 as const,
        locations: v1.locations.map((loc) => ({
          ...loc,
          warp_in: loc.warp_in.slice(0, WARP_IN_MAX_LENGTH),
        })),
      }
    },
  },
  // ↑ To add v3: append { fromVersion: 2, toVersion: 3, inputSchema: DocumentSchemaV2, ... }
]

// ── Migration runner ───────────────────────────────────────────────────────────

const SUPPORTED_VERSIONS: ReadonlySet<number> = new Set([
  LOCATIONS_SCHEMA_VERSION,
  ...MIGRATIONS.map((m) => m.fromVersion),
])

export function migrateDocument(raw: unknown): LocationsDocument {
  const obj = raw as Record<string, unknown>

  if (obj?.schema !== LOCATIONS_SCHEMA_NAME) {
    throw new AclClientError(
      AclError.UnexpectedResponse,
      `Unknown schema: expected "${LOCATIONS_SCHEMA_NAME}", got "${obj?.schema}"`,
    )
  }

  const version = obj.schema_version as number
  if (!SUPPORTED_VERSIONS.has(version)) {
    throw new AclClientError(
      AclError.UnexpectedResponse,
      `Unsupported schema version: ${version}`,
    )
  }

  let current: unknown = raw

  for (const step of MIGRATIONS) {
    if ((current as Record<string, unknown>).schema_version !== step.fromVersion) continue

    const inputResult = step.inputSchema.safeParse(current)
    if (!inputResult.success) {
      throw new AclClientError(
        AclError.ValidationFailed,
        `v${step.fromVersion} document failed input validation before migration to v${step.toVersion}: ${inputResult.error.message}`,
      )
    }

    const migrated = step.migrate(inputResult.data)

    const outputResult = step.outputSchema.safeParse(migrated)
    if (!outputResult.success) {
      throw new AclClientError(
        AclError.ValidationFailed,
        `Migration v${step.fromVersion}→v${step.toVersion} produced an invalid document: ${outputResult.error.message}`,
      )
    }

    current = outputResult.data
  }

  // Final parse confirms the fully-migrated document satisfies the current schema.
  const finalResult = DocumentSchemaV2.safeParse(current)
  if (!finalResult.success) {
    throw new AclClientError(
      AclError.UnexpectedResponse,
      `Document is not valid at v${LOCATIONS_SCHEMA_VERSION}: ${finalResult.error.message}`,
    )
  }

  return finalResult.data
}

// ── Write-time validation ──────────────────────────────────────────────────────

export function validateLocation(location: Location): void {
  const result = LocationSchemaV2.safeParse(location)
  if (!result.success) {
    throw new AclClientError(AclError.ValidationFailed, result.error.message)
  }
}
