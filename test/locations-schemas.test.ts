import { describe, it, expect } from '@jest/globals'
import {
  LOCATIONS_SCHEMA_NAME,
  LOCATIONS_SCHEMA_VERSION,
  WARP_IN_MAX_LENGTH,
  TRANSPONDER_CODE_MAX_LENGTH,
  migrateDocument,
  validateLocation,
  LocationSchemaV2,
  DocumentSchemaV2,
  LocationSchemaV3,
  DocumentSchemaV3,
} from '../src/locations-schemas'
import { AclError } from '../src/errors'

// ── migrateDocument ───────────────────────────────────────────────────────────

describe('migrateDocument', () => {
  const baseV3 = {
    schema: LOCATIONS_SCHEMA_NAME,
    schema_version: LOCATIONS_SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
    locations: [],
  }

  it('passes through a valid v3 document unchanged', () => {
    const result = migrateDocument(baseV3)
    expect(result.schema_version).toBe(LOCATIONS_SCHEMA_VERSION)
  })

  it('throws UnexpectedResponse when schema name is wrong', () => {
    expect(() => migrateDocument({ ...baseV3, schema: 'wrong' })).toThrow(
      expect.objectContaining({ code: AclError.UnexpectedResponse }),
    )
  })

  it('throws UnexpectedResponse for an unsupported version number', () => {
    expect(() => migrateDocument({ ...baseV3, schema_version: 99 })).toThrow(
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

    it('migrates a v1 document all the way to the current version', () => {
      const result = migrateDocument(baseV1)
      expect(result.schema_version).toBe(LOCATIONS_SCHEMA_VERSION)
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

  describe('v2 → v3 migration', () => {
    const baseV2 = {
      schema: LOCATIONS_SCHEMA_NAME,
      schema_version: 2,
      updated_at: new Date().toISOString(),
      locations: [],
    }

    it('migrates a v2 document and bumps schema_version to 3', () => {
      const result = migrateDocument(baseV2)
      expect(result.schema_version).toBe(3)
    })

    it('defaults existing locations to transponder_setting "tribe" with no code', () => {
      const v2Doc = {
        ...baseV2,
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
      const result = migrateDocument(v2Doc)
      expect(result.locations[0].transponder_setting).toBe('tribe')
      expect(result.locations[0].transponder_code).toBeUndefined()
      expect(result.locations[0].warp_in).toBe('P1L0')
    })

    it('throws ValidationFailed when the v2 document fails input validation', () => {
      const corruptV2 = {
        ...baseV2,
        locations: [{ id: 999 /* must be string */, warp_in: 'P1L0' }],
      }
      expect(() => migrateDocument(corruptV2)).toThrow(
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
    transponder_setting: 'tribe' as const,
  }

  it('does not throw for a valid location', () => {
    expect(() => validateLocation(validLocation)).not.toThrow()
  })

  it('throws ValidationFailed when transponder_setting is missing', () => {
    const withoutSetting: Record<string, unknown> = { ...validLocation }
    delete withoutSetting.transponder_setting
    expect(() => validateLocation(withoutSetting as any)).toThrow(
      expect.objectContaining({ code: AclError.ValidationFailed }),
    )
  })

  it('throws ValidationFailed for an unknown transponder_setting value', () => {
    expect(() =>
      validateLocation({
        ...validLocation,
        transponder_setting: 'friends-only' as any,
      }),
    ).toThrow(expect.objectContaining({ code: AclError.ValidationFailed }))
  })

  it('accepts every valid transponder_setting without a code', () => {
    for (const transponder_setting of ['public', 'tribe'] as const) {
      expect(() =>
        validateLocation({ ...validLocation, transponder_setting }),
      ).not.toThrow()
    }
  })

  it('throws ValidationFailed when setting is "transponder_code" but no code is given', () => {
    expect(() =>
      validateLocation({
        ...validLocation,
        transponder_setting: 'transponder_code',
      }),
    ).toThrow(expect.objectContaining({ code: AclError.ValidationFailed }))
  })

  it('accepts setting "transponder_code" with an alphanumeric code', () => {
    expect(() =>
      validateLocation({
        ...validLocation,
        transponder_setting: 'transponder_code',
        transponder_code: 'Alpha7Bravo9',
      }),
    ).not.toThrow()
  })

  it('accepts transponder_code exactly at the 32-character limit', () => {
    expect(() =>
      validateLocation({
        ...validLocation,
        transponder_code: 'a'.repeat(TRANSPONDER_CODE_MAX_LENGTH),
      }),
    ).not.toThrow()
  })

  it('throws ValidationFailed when transponder_code exceeds 32 characters', () => {
    expect(() =>
      validateLocation({
        ...validLocation,
        transponder_code: 'a'.repeat(TRANSPONDER_CODE_MAX_LENGTH + 1),
      }),
    ).toThrow(expect.objectContaining({ code: AclError.ValidationFailed }))
  })

  it('throws ValidationFailed when transponder_code contains non-alphanumerics', () => {
    for (const transponder_code of ['TX-42', 'has space', 'p@ss', '']) {
      expect(() =>
        validateLocation({ ...validLocation, transponder_code }),
      ).toThrow(expect.objectContaining({ code: AclError.ValidationFailed }))
    }
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
      schema_version: 2,
      updated_at: new Date().toISOString(),
      locations: [],
    })
    expect(result.success).toBe(true)
  })
})

describe('LocationSchemaV3', () => {
  it('rejects a location without transponder_setting', () => {
    const result = LocationSchemaV3.safeParse({
      id: 'x',
      solar_system: 'Sol',
      structure_type: 'gate',
      warp_in: 'P1L0',
      description: 'test',
    })
    expect(result.success).toBe(false)
  })

  it('accepts a location without a transponder_code (optional)', () => {
    const result = LocationSchemaV3.safeParse({
      id: 'x',
      solar_system: 'Sol',
      structure_type: 'gate',
      warp_in: 'P1L0',
      description: 'test',
      transponder_setting: 'public',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a location with an alphanumeric transponder_code', () => {
    const result = LocationSchemaV3.safeParse({
      id: 'x',
      solar_system: 'Sol',
      structure_type: 'gate',
      warp_in: 'P1L0',
      description: 'test',
      transponder_setting: 'transponder_code',
      transponder_code: 'Zulu99',
    })
    expect(result.success).toBe(true)
  })

  it('rejects setting "transponder_code" without a code', () => {
    const result = LocationSchemaV3.safeParse({
      id: 'x',
      solar_system: 'Sol',
      structure_type: 'gate',
      warp_in: 'P1L0',
      description: 'test',
      transponder_setting: 'transponder_code',
    })
    expect(result.success).toBe(false)
  })
})

describe('DocumentSchemaV3', () => {
  it('rejects a document with schema_version: 2', () => {
    const result = DocumentSchemaV3.safeParse({
      schema: LOCATIONS_SCHEMA_NAME,
      schema_version: 2,
      updated_at: new Date().toISOString(),
      locations: [],
    })
    expect(result.success).toBe(false)
  })

  it('accepts a valid v3 document', () => {
    const result = DocumentSchemaV3.safeParse({
      schema: LOCATIONS_SCHEMA_NAME,
      schema_version: LOCATIONS_SCHEMA_VERSION,
      updated_at: new Date().toISOString(),
      locations: [],
    })
    expect(result.success).toBe(true)
  })
})
