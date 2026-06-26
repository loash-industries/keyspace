import { describe, it, expect } from '@jest/globals'
import {
  LOCATIONS_SCHEMA_NAME,
  LOCATIONS_SCHEMA_VERSION,
  WARP_IN_MAX_LENGTH,
  migrateDocument,
  validateLocation,
  LocationSchemaV2,
  DocumentSchemaV2,
} from '../src/locations-schemas'
import { AclError } from '../src/errors'

// ── migrateDocument ───────────────────────────────────────────────────────────

describe('migrateDocument', () => {
  const baseV2 = {
    schema: LOCATIONS_SCHEMA_NAME,
    schema_version: LOCATIONS_SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
    locations: [],
  }

  it('passes through a valid v2 document unchanged', () => {
    const result = migrateDocument(baseV2)
    expect(result.schema_version).toBe(LOCATIONS_SCHEMA_VERSION)
  })

  it('throws UnexpectedResponse when schema name is wrong', () => {
    expect(() => migrateDocument({ ...baseV2, schema: 'wrong' })).toThrow(
      expect.objectContaining({ code: AclError.UnexpectedResponse }),
    )
  })

  it('throws UnexpectedResponse for an unsupported version number', () => {
    expect(() => migrateDocument({ ...baseV2, schema_version: 99 })).toThrow(
      expect.objectContaining({ code: AclError.UnexpectedResponse }),
    )
  })

  describe('v1 → v2 migration', () => {
    const baseV1 = {
      schema: LOCATIONS_SCHEMA_NAME,
      schema_version: 1,
      updated_at: new Date().toISOString(),
      locations: [],
    }

    it('migrates a v1 document and bumps schema_version to 2', () => {
      const result = migrateDocument(baseV1)
      expect(result.schema_version).toBe(2)
    })

    it('preserves warp_in values within the 32-character limit', () => {
      const v1Doc = {
        ...baseV1,
        locations: [
          {
            id: 'a',
            solar_system: 'Sol',
            structure_type: 'gate',
            warp_in: 'P1L0',
            description: 'test',
          },
        ],
      }
      const result = migrateDocument(v1Doc)
      expect(result.locations[0].warp_in).toBe('P1L0')
    })

    it('truncates warp_in to 32 characters when the v1 value is longer', () => {
      const longValue = 'x'.repeat(50)
      const v1Doc = {
        ...baseV1,
        locations: [
          {
            id: 'b',
            solar_system: 'Sol',
            structure_type: 'gate',
            warp_in: longValue,
            description: 'test',
          },
        ],
      }
      const result = migrateDocument(v1Doc)
      expect(result.locations[0].warp_in).toHaveLength(WARP_IN_MAX_LENGTH)
    })

    it('throws ValidationFailed when the v1 document fails input validation', () => {
      const corruptV1 = {
        ...baseV1,
        locations: [{ id: 999 /* must be string */, warp_in: 'P1L0' }],
      }
      expect(() => migrateDocument(corruptV1)).toThrow(
        expect.objectContaining({ code: AclError.ValidationFailed }),
      )
    })
  })
})

// ── validateLocation ──────────────────────────────────────────────────────────

describe('validateLocation', () => {
  const validLocation = {
    id: 'loc-1',
    solar_system: 'Sol',
    structure_type: 'gate',
    warp_in: 'P1L0',
    description: 'test',
  }

  it('does not throw for a valid location', () => {
    expect(() => validateLocation(validLocation)).not.toThrow()
  })

  it('does not throw for warp_in exactly at the 32-character limit', () => {
    expect(() =>
      validateLocation({
        ...validLocation,
        warp_in: 'a'.repeat(WARP_IN_MAX_LENGTH),
      }),
    ).not.toThrow()
  })

  it('throws ValidationFailed when warp_in exceeds 32 characters', () => {
    expect(() =>
      validateLocation({
        ...validLocation,
        warp_in: 'a'.repeat(WARP_IN_MAX_LENGTH + 1),
      }),
    ).toThrow(expect.objectContaining({ code: AclError.ValidationFailed }))
  })

  it('accepts any string format for warp_in (not just PxLx)', () => {
    const formats = ['Jita IV - Moon 4', '0,0,0', 'custom-label', '']
    for (const warp_in of formats) {
      expect(() =>
        validateLocation({ ...validLocation, warp_in }),
      ).not.toThrow()
    }
  })
})

// ── Zod schema exports ────────────────────────────────────────────────────────

describe('LocationSchemaV2', () => {
  it('rejects a location with warp_in over 32 chars', () => {
    const result = LocationSchemaV2.safeParse({
      id: 'x',
      solar_system: 'Sol',
      structure_type: 'gate',
      warp_in: 'a'.repeat(33),
      description: 'test',
    })
    expect(result.success).toBe(false)
  })

  it('accepts a location with all required fields', () => {
    const result = LocationSchemaV2.safeParse({
      id: 'x',
      solar_system: 'Sol',
      structure_type: 'gate',
      warp_in: 'P1L0',
      description: 'test',
    })
    expect(result.success).toBe(true)
  })
})

describe('DocumentSchemaV2', () => {
  it('rejects a document with schema_version: 1', () => {
    const result = DocumentSchemaV2.safeParse({
      schema: LOCATIONS_SCHEMA_NAME,
      schema_version: 1,
      updated_at: new Date().toISOString(),
      locations: [],
    })
    expect(result.success).toBe(false)
  })

  it('accepts a valid v2 document', () => {
    const result = DocumentSchemaV2.safeParse({
      schema: LOCATIONS_SCHEMA_NAME,
      schema_version: LOCATIONS_SCHEMA_VERSION,
      updated_at: new Date().toISOString(),
      locations: [],
    })
    expect(result.success).toBe(true)
  })
})
