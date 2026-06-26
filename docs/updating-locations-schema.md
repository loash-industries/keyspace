# Updating the Locations Schema

This document explains how to make a breaking or additive change to the `triex.locations` document schema stored inside a keyspace entry.

## Background

Location documents are encrypted blobs stored on-chain. Because existing blobs are written at whatever schema version was current at the time, the library must be able to read and upgrade older versions. This is handled by a migration chain in [`src/locations-schemas.ts`](../src/locations-schemas.ts).

The chain has three guarantees:

1. **Monotonic** — migrations are applied in version order, one step at a time (v1→v2→v3, never v1→v3 directly).
2. **Validated** — each step validates the input document against the old schema and the output document against the new schema using Zod. Either failure throws `AclError.ValidationFailed`.
3. **One script per bump** — there is exactly one `MigrationStep` object per version increment. Adding a new version means appending one object; nothing else in the runner changes.

---

## Step-by-step: bumping to vN

### 1. Write the new Zod schema

Add a new `LocationSchemaVN` and `DocumentSchemaVN` below the existing ones. **Never edit or delete old schemas** — they are required forever as migration inputs.

```ts
// vN: describe what changed
const LocationSchemaVN = z.object({
  id: z.string(),
  solar_system: z.string(),
  structure_type: z.string(),
  warp_in: z.string().max(WARP_IN_MAX_LENGTH),
  description: z.string(),
  // new_field: z.string(), ← whatever you added
})

const DocumentSchemaVN = z.object({
  schema: z.literal(LOCATIONS_SCHEMA_NAME),
  schema_version: z.literal(N),
  updated_at: z.string(),
  locations: z.array(LocationSchemaVN),
})
```

### 2. Update the exported current types

Replace the `export const LocationSchemaV2 = ...` and `export const DocumentSchemaV2 = ...` lines (and their `export type` aliases) with your new versions:

```ts
export const LocationSchemaVN = z.object({ ... })  // ← your new schema
export const DocumentSchemaVN = z.object({ ... })

export type Location = z.infer<typeof LocationSchemaVN>
export type LocationsDocument = z.infer<typeof DocumentSchemaVN>
```

### 3. Bump `LOCATIONS_SCHEMA_VERSION`

```ts
export const LOCATIONS_SCHEMA_VERSION = N as const
```

### 4. Append a migration step

Add one entry to the `MIGRATIONS` array, immediately after the last existing step:

```ts
{
  fromVersion: N - 1,
  toVersion: N,
  inputSchema: DocumentSchemaV_prev,   // the schema you're migrating FROM
  outputSchema: DocumentSchemaVN,      // the schema you're migrating TO
  migrate: (doc: unknown) => {
    const prev = doc as z.infer<typeof DocumentSchemaV_prev>
    return {
      ...prev,
      schema_version: N as const,
      // apply your data transformation here
      locations: prev.locations.map((loc) => ({
        ...loc,
        // new_field: deriveDefaultValue(loc),
      })),
    }
  },
},
```

The `migrate` function receives a document that has already passed `inputSchema.safeParse`. The return value is immediately run through `outputSchema.safeParse`. If either parse fails, a `ValidationFailed` error is thrown — you will catch this during tests before it reaches production.

### 5. Update `CURRENT_DOCUMENT_SCHEMA`

Near the top of the migration steps section in `locations-schemas.ts`, update the `CURRENT_DOCUMENT_SCHEMA` constant to reference the new schema:

```ts
const CURRENT_DOCUMENT_SCHEMA = DocumentSchemaVN
```

This constant is used both by the final validation in `migrateDocument` and must stay in sync with `LOCATIONS_SCHEMA_VERSION`.

### 6. Update `LOCATIONS_SCHEMA_VERSION` in `index.ts`

No change needed — `index.ts` re-exports the constant directly from `locations.ts`, which re-exports it from `locations-schemas.ts`.

### 7. Update write-time validation

`validateLocation` uses the current schema. Update it to reference `LocationSchemaVN`:

```ts
export function validateLocation(location: Location): void {
  const result = LocationSchemaVN.safeParse(location)
  ...
}
```

### 8. Write tests

Add a `MigrationStep` test block in [`test/locations-schemas.test.ts`](../test/locations-schemas.test.ts) covering:

- A valid v(N-1) document migrates successfully to vN.
- Any data transformations applied in `migrate` (defaults, truncations, renames) produce the expected output.
- A corrupted v(N-1) document (invalid field type) throws `ValidationFailed` on input.
- `validateLocation` enforces any new constraints introduced by vN.

---

## What happens at runtime

When `LocationsClient.download()` is called on an old document:

```
raw bytes
  → JSON.parse
  → migrateDocument()
      ├─ check schema name
      ├─ check version is in SUPPORTED_VERSIONS (derived from MIGRATIONS + current)
      ├─ for each applicable MigrationStep (in order):
      │    ├─ inputSchema.safeParse  → ValidationFailed if corrupt
      │    ├─ migrate()
      │    └─ outputSchema.safeParse → ValidationFailed if migration produced bad data
      └─ final DocumentSchemaVN.safeParse → UnexpectedResponse if still wrong
  → LocationsDocument (typed as current version)
```

The migrated document is returned in memory but **not automatically persisted**. It will be written back at the current version the next time any write operation (`addLocation`, `updateLocation`, `removeLocation`) is called. If you want to force a persist without a data change, call `reencrypt()`.

---

## Version history

| Version | Change |
|---------|--------|
| 1 | Initial schema. `warp_in` stored as free-form string; `PxLx` convention assumed but not enforced. |
| 2 | `warp_in` constrained to ≤ 32 characters. Any format accepted. Values longer than 32 chars in v1 documents are truncated during migration. |
