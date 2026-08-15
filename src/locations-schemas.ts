import { z } from 'zod'
import { AclClientError, AclError } from './errors'

// ── Constants ──────────────────────────────────────────────────────────────────

export const LOCATIONS_SCHEMA_NAME = 'triex.locations' as const
export const LOCATIONS_SCHEMA_VERSION = 5 as const
export const WARP_IN_MAX_LENGTH = 32 as const
export const TRANSPONDER_CODE_MAX_LENGTH = 32 as const

/** Placeholder destination backfilled onto pre-v5 catapult locations during migration. */
export const DESTINATION_UNKNOWN = 'UNKNOWN' as const

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

// v2: warp_in is any string ≤ 32 characters
export const LocationSchemaV2 = z.object({
  id: z.string(),
  solar_system: z.string(),
  structure_type: z.string(),
  warp_in: z
    .string()
    .max(
      WARP_IN_MAX_LENGTH,
      `warp_in must be ≤ ${WARP_IN_MAX_LENGTH} characters`,
    ),
  description: z.string(),
})

export const DocumentSchemaV2 = z.object({
  schema: z.literal(LOCATIONS_SCHEMA_NAME),
  schema_version: z.literal(2),
  updated_at: z.string(),
  locations: z.array(LocationSchemaV2),
})

// v3: adds transponder_setting and an optional transponder_code
export const TransponderSettingSchema = z.enum([
  'public',
  'tribe',
  'transponder_code',
])

export const LocationSchemaV3 = LocationSchemaV2.extend({
  transponder_setting: TransponderSettingSchema,
  transponder_code: z
    .string()
    .max(
      TRANSPONDER_CODE_MAX_LENGTH,
      `transponder_code must be ≤ ${TRANSPONDER_CODE_MAX_LENGTH} characters`,
    )
    .regex(
      /^[A-Za-z0-9]+$/,
      'transponder_code must contain only letters and numbers',
    )
    .optional(),
}).refine(
  (loc) =>
    loc.transponder_setting !== 'transponder_code' ||
    loc.transponder_code !== undefined,
  {
    message:
      'transponder_code is required when transponder_setting is "transponder_code"',
    path: ['transponder_code'],
  },
)

export const DocumentSchemaV3 = z.object({
  schema: z.literal(LOCATIONS_SCHEMA_NAME),
  schema_version: z.literal(3),
  updated_at: z.string(),
  locations: z.array(LocationSchemaV3),
})

// v4 (current): transponder_setting is now optional — structures without a
// warp-in transponder beacon simply omit it (and the code alongside it).
export const LocationSchemaV4 = LocationSchemaV2.extend({
  transponder_setting: TransponderSettingSchema.optional(),
  transponder_code: z
    .string()
    .max(
      TRANSPONDER_CODE_MAX_LENGTH,
      `transponder_code must be ≤ ${TRANSPONDER_CODE_MAX_LENGTH} characters`,
    )
    .regex(
      /^[A-Za-z0-9]+$/,
      'transponder_code must contain only letters and numbers',
    )
    .optional(),
}).refine(
  (loc) =>
    loc.transponder_setting !== 'transponder_code' ||
    loc.transponder_code !== undefined,
  {
    message:
      'transponder_code is required when transponder_setting is "transponder_code"',
    path: ['transponder_code'],
  },
)

export const DocumentSchemaV4 = z.object({
  schema: z.literal(LOCATIONS_SCHEMA_NAME),
  schema_version: z.literal(4),
  updated_at: z.string(),
  locations: z.array(LocationSchemaV4),
})

// v5 (current): structure_type and transponder_setting become discriminated
// unions instead of a plain string + a `.refine()`-checked optional pair.
// Combined via z.intersection so each axis narrows independently in TS.
//
// structure_type: 'gate' | 'catapult' | 'storage_unit' | 'turret'.
//   - 'catapult' requires destination_solar_system — this document is the
//     source of truth for catapult destinations.
//   - 'gate' has NO destination_solar_system field: a gate's destination is
//     derived from on-chain state, not stored here.
//   - 'storage_unit' / 'turret' carry no structure-specific fields.
//
// transponder_setting: 'public' | 'tribe' | 'transponder_code' | 'none'.
//   'none' replaces v4's "field omitted" convention with an explicit state
//   so the type checker can discriminate on it; transponder_code is only
//   valid (and required) alongside 'transponder_code'.

const LocationBaseFieldsV5 = {
  id: z.string(),
  solar_system: z.string(),
  warp_in: z
    .string()
    .max(
      WARP_IN_MAX_LENGTH,
      `warp_in must be ≤ ${WARP_IN_MAX_LENGTH} characters`,
    ),
  description: z.string(),
}

export const StructureFieldsSchemaV5 = z.discriminatedUnion('structure_type', [
  z.object({ ...LocationBaseFieldsV5, structure_type: z.literal('gate') }),
  z.object({
    ...LocationBaseFieldsV5,
    structure_type: z.literal('catapult'),
    destination_solar_system: z.string(),
  }),
  z.object({
    ...LocationBaseFieldsV5,
    structure_type: z.literal('storage_unit'),
  }),
  z.object({ ...LocationBaseFieldsV5, structure_type: z.literal('turret') }),
])

export const TransponderFieldsSchemaV5 = z.discriminatedUnion(
  'transponder_setting',
  [
    z.object({ transponder_setting: z.literal('none') }),
    z.object({ transponder_setting: z.literal('public') }),
    z.object({ transponder_setting: z.literal('tribe') }),
    z.object({
      transponder_setting: z.literal('transponder_code'),
      transponder_code: z
        .string()
        .max(
          TRANSPONDER_CODE_MAX_LENGTH,
          `transponder_code must be ≤ ${TRANSPONDER_CODE_MAX_LENGTH} characters`,
        )
        .regex(
          /^[A-Za-z0-9]+$/,
          'transponder_code must contain only letters and numbers',
        ),
    }),
  ],
)

export const LocationSchemaV5 = z.intersection(
  StructureFieldsSchemaV5,
  TransponderFieldsSchemaV5,
)

export const DocumentSchemaV5 = z.object({
  schema: z.literal(LOCATIONS_SCHEMA_NAME),
  schema_version: z.literal(LOCATIONS_SCHEMA_VERSION),
  updated_at: z.string(),
  locations: z.array(LocationSchemaV5),
})

export type StructureType = z.infer<
  typeof StructureFieldsSchemaV5
>['structure_type']
export type TransponderSetting = z.infer<
  typeof TransponderFieldsSchemaV5
>['transponder_setting']
export type Location = z.infer<typeof LocationSchemaV5>
export type LocationsDocument = z.infer<typeof DocumentSchemaV5>

// Flat, fully-optional field bag for partial updates. TS can't express
// "a valid subset of a discriminated union" as a single mapped type — e.g.
// switching structure_type to 'catapult' without also supplying
// destination_solar_system is only caught by validateLocation() at runtime,
// not by this type. Keep updates minimal and let validateLocation reject
// invalid combinations after merging with the existing record.
export type LocationUpdate = Partial<{
  solar_system: string
  warp_in: string
  description: string
  structure_type: StructureType
  destination_solar_system: string
  transponder_setting: TransponderSetting
  transponder_code: string
}>

// Update this constant alongside LOCATIONS_SCHEMA_VERSION when bumping the schema version.
const CURRENT_DOCUMENT_SCHEMA = DocumentSchemaV5

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

const STRUCTURE_TYPES_V5 = [
  'gate',
  'catapult',
  'storage_unit',
  'turret',
] as const

// v4 predates the enum — trim/lowercase/space-to-underscore so pre-existing
// formatting variants (e.g. "Storage Unit") match the canonical slug instead
// of failing migration outright.
function normalizeStructureTypeV5(
  rawType: string,
  locationId: string,
): (typeof STRUCTURE_TYPES_V5)[number] {
  const normalized = rawType.trim().toLowerCase().replace(/\s+/g, '_')
  const match = STRUCTURE_TYPES_V5.find((t) => t === normalized)
  if (!match) {
    throw new AclClientError(
      AclError.ValidationFailed,
      `Location "${locationId}" has unrecognized structure_type "${rawType}" — cannot migrate to v${LOCATIONS_SCHEMA_VERSION}. Valid types: ${STRUCTURE_TYPES_V5.join(', ')}`,
    )
  }
  return match
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
  {
    // v2 → v3: transponder_setting added (public | tribe | transponder_code)
    // with an optional transponder_code. Default existing locations to 'tribe',
    // which matches the pre-v3 behavior of anyone-with-ACL-access visibility.
    fromVersion: 2,
    toVersion: 3,
    inputSchema: DocumentSchemaV2,
    outputSchema: DocumentSchemaV3,
    migrate: (doc: unknown) => {
      const v2 = doc as z.infer<typeof DocumentSchemaV2>
      return {
        ...v2,
        schema_version: 3 as const,
        locations: v2.locations.map((loc) => ({
          ...loc,
          transponder_setting: 'tribe' as const,
        })),
      }
    },
  },
  {
    // v3 → v4: transponder_setting relaxed from required to optional.
    // Pure relaxation — every valid v3 document is already a valid v4
    // document, so only the version stamp changes.
    fromVersion: 3,
    toVersion: 4,
    inputSchema: DocumentSchemaV3,
    outputSchema: DocumentSchemaV4,
    migrate: (doc: unknown) => {
      const v3 = doc as z.infer<typeof DocumentSchemaV3>
      return {
        ...v3,
        schema_version: 4 as const,
      }
    },
  },
  {
    // v4 → v5: structure_type and transponder_setting become discriminated
    // unions. Existing catapult locations predate destination_solar_system
    // and are backfilled with DESTINATION_UNKNOWN — callers must patch in
    // the real destination via updateLocation.
    fromVersion: 4,
    toVersion: 5,
    inputSchema: DocumentSchemaV4,
    outputSchema: DocumentSchemaV5,
    migrate: (doc: unknown) => {
      const v4 = doc as z.infer<typeof DocumentSchemaV4>
      return {
        ...v4,
        schema_version: 5 as const,
        locations: v4.locations.map((loc) => {
          const structureType = normalizeStructureTypeV5(
            loc.structure_type,
            loc.id,
          )

          const transponderFields =
            loc.transponder_setting === undefined
              ? { transponder_setting: 'none' as const }
              : loc.transponder_setting === 'transponder_code'
                ? {
                    transponder_setting: 'transponder_code' as const,
                    transponder_code: loc.transponder_code as string,
                  }
                : { transponder_setting: loc.transponder_setting }

          return {
            id: loc.id,
            solar_system: loc.solar_system,
            warp_in: loc.warp_in,
            description: loc.description,
            structure_type: structureType,
            ...(structureType === 'catapult'
              ? { destination_solar_system: DESTINATION_UNKNOWN }
              : {}),
            ...transponderFields,
          }
        }),
      }
    },
  },
  // ↑ To add v6: append { fromVersion: 5, toVersion: 6, inputSchema: DocumentSchemaV5, ... }
]

// ── Migration runner ───────────────────────────────────────────────────────────

// Keyed by fromVersion for O(1) lookup; order-independent multi-hop traversal.
const migrationMap = new Map(MIGRATIONS.map((m) => [m.fromVersion, m]))

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
  let step = migrationMap.get(version)

  while (step !== undefined) {
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
    step = migrationMap.get(
      (current as Record<string, unknown>).schema_version as number,
    )
  }

  // Validate the document against the current schema. Return current (not finalResult.data)
  // to preserve any unknown fields written by a newer client for forward-compatibility.
  const finalResult = CURRENT_DOCUMENT_SCHEMA.safeParse(current)
  if (!finalResult.success) {
    throw new AclClientError(
      AclError.UnexpectedResponse,
      `Document is not valid at v${LOCATIONS_SCHEMA_VERSION}: ${finalResult.error.message}`,
    )
  }

  return current as LocationsDocument
}

// ── Write-time validation ──────────────────────────────────────────────────────

/** Validates arbitrary input and returns the parsed, type-narrowed Location (unknown/stray fields stripped). */
export function validateLocation(location: unknown): Location {
  const result = LocationSchemaV5.safeParse(location)
  if (!result.success) {
    throw new AclClientError(AclError.ValidationFailed, result.error.message)
  }
  return result.data
}
