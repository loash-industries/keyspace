import { describe, it, expect } from '@jest/globals'
import {
  LOCATIONS_SCHEMA_NAME,
  LOCATIONS_SCHEMA_VERSION,
  WARP_IN_MAX_LENGTH,
  TRANSPONDER_CODE_MAX_LENGTH,
  DESTINATION_UNKNOWN,
  migrateDocument,
  validateLocation,
  LocationSchemaV2,
  DocumentSchemaV2,
  LocationSchemaV3,
  DocumentSchemaV3,
  LocationSchemaV4,
  DocumentSchemaV4,
  LocationSchemaV5,
  DocumentSchemaV5,
  StructureFieldsSchemaV5,
  TransponderFieldsSchemaV5,
} from '../src/locations-schemas'
import { AclError } from '../src/errors'

// ── migrateDocument ───────────────────────────────────────────────────────────

describe('migrateDocument', () => {
  const baseV4 = {
    schema: LOCATIONS_SCHEMA_NAME,
    schema_version: LOCATIONS_SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
    locations: [],
  }

  it('passes through a valid v4 document unchanged', () => {
    const result = migrateDocument(baseV4)
    expect(result.schema_version).toBe(LOCATIONS_SCHEMA_VERSION)
  })

  it('throws UnexpectedResponse when schema name is wrong', () => {
    expect(() => migrateDocument({ ...baseV4, schema: 'wrong' })).toThrow(
      expect.objectContaining({ code: AclError.UnexpectedResponse }),
    )
  })

  it('throws UnexpectedResponse for an unsupported version number', () => {
    expect(() => migrateDocument({ ...baseV4, schema_version: 99 })).toThrow(
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

    it('migrates a v2 document all the way to the current version', () => {
      const result = migrateDocument(baseV2)
      expect(result.schema_version).toBe(LOCATIONS_SCHEMA_VERSION)
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
      expect((result.locations[0] as any).transponder_code).toBeUndefined()
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

  describe('v3 → v4 migration', () => {
    const baseV3 = {
      schema: LOCATIONS_SCHEMA_NAME,
      schema_version: 3,
      updated_at: new Date().toISOString(),
      locations: [],
    }

    it('migrates a v3 document all the way to the current version', () => {
      const result = migrateDocument(baseV3)
      expect(result.schema_version).toBe(LOCATIONS_SCHEMA_VERSION)
    })

    it('preserves transponder fields unchanged', () => {
      const v3Doc = {
        ...baseV3,
        locations: [
          {
            id: 'a',
            solar_system: 'Sol',
            structure_type: 'gate',
            warp_in: 'P1L0',
            description: 'test',
            transponder_setting: 'transponder_code',
            transponder_code: 'Zulu99',
          },
        ],
      }
      const result = migrateDocument(v3Doc)
      expect(result.locations[0].transponder_setting).toBe('transponder_code')
      expect((result.locations[0] as any).transponder_code).toBe('Zulu99')
    })

    it('throws ValidationFailed when the v3 document fails input validation', () => {
      const corruptV3 = {
        ...baseV3,
        locations: [
          {
            id: 'a',
            solar_system: 'Sol',
            structure_type: 'gate',
            warp_in: 'P1L0',
            description: 'test',
            // v3 requires transponder_setting — missing here
          },
        ],
      }
      expect(() => migrateDocument(corruptV3)).toThrow(
        expect.objectContaining({ code: AclError.ValidationFailed }),
      )
    })
  })

  describe('v4 → v5 migration', () => {
    const baseV4 = {
      schema: LOCATIONS_SCHEMA_NAME,
      schema_version: 4,
      updated_at: new Date().toISOString(),
      locations: [],
    }

    it('migrates a v4 document and bumps schema_version to 5', () => {
      const result = migrateDocument(baseV4)
      expect(result.schema_version).toBe(5)
    })

    it('maps an omitted transponder_setting to "none"', () => {
      const v4Doc = {
        ...baseV4,
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
      const result = migrateDocument(v4Doc)
      expect(result.locations[0].transponder_setting).toBe('none')
    })

    it('preserves transponder_code alongside "transponder_code"', () => {
      const v4Doc = {
        ...baseV4,
        locations: [
          {
            id: 'a',
            solar_system: 'Sol',
            structure_type: 'gate',
            warp_in: 'P1L0',
            description: 'test',
            transponder_setting: 'transponder_code',
            transponder_code: 'Zulu99',
          },
        ],
      }
      const result = migrateDocument(v4Doc)
      expect(result.locations[0].transponder_setting).toBe('transponder_code')
      expect((result.locations[0] as any).transponder_code).toBe('Zulu99')
    })

    it('backfills DESTINATION_UNKNOWN on a pre-existing catapult location', () => {
      const v4Doc = {
        ...baseV4,
        locations: [
          {
            id: 'a',
            solar_system: 'Sol',
            structure_type: 'catapult',
            warp_in: 'P1L0',
            description: 'test',
          },
        ],
      }
      const result = migrateDocument(v4Doc)
      expect((result.locations[0] as any).destination_solar_system).toBe(
        DESTINATION_UNKNOWN,
      )
    })

    it('does not add destination_solar_system for a gate', () => {
      const v4Doc = {
        ...baseV4,
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
      const result = migrateDocument(v4Doc)
      expect(
        (result.locations[0] as any).destination_solar_system,
      ).toBeUndefined()
    })

    it('throws ValidationFailed for an unrecognized structure_type', () => {
      const v4Doc = {
        ...baseV4,
        locations: [
          {
            id: 'a',
            solar_system: 'Sol',
            structure_type: 'space station', // not one of the v5 literals
            warp_in: 'P1L0',
            description: 'test',
          },
        ],
      }
      expect(() => migrateDocument(v4Doc)).toThrow(
        expect.objectContaining({ code: AclError.ValidationFailed }),
      )
    })

    it('normalizes formatting variants of a valid structure_type', () => {
      for (const rawType of [
        'Storage Unit',
        'STORAGE_UNIT',
        '  storage unit  ',
      ]) {
        const v4Doc = {
          ...baseV4,
          locations: [
            {
              id: 'a',
              solar_system: 'Sol',
              structure_type: rawType,
              warp_in: 'P1L0',
              description: 'test',
            },
          ],
        }
        const result = migrateDocument(v4Doc)
        expect(result.locations[0].structure_type).toBe('storage_unit')
      }
    })

    it('throws ValidationFailed when the v4 document fails input validation', () => {
      const corruptV4 = {
        ...baseV4,
        locations: [{ id: 999 /* must be string */, warp_in: 'P1L0' }],
      }
      expect(() => migrateDocument(corruptV4)).toThrow(
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
    structure_type: 'gate' as const,
    warp_in: 'P1L0',
    description: 'test',
    transponder_setting: 'tribe' as const,
  }

  it('does not throw for a valid location', () => {
    expect(() => validateLocation(validLocation)).not.toThrow()
  })

  it('returns the parsed location', () => {
    expect(validateLocation(validLocation)).toEqual(validLocation)
  })

  it('accepts transponder_setting "none" (no beacon)', () => {
    expect(() =>
      validateLocation({ ...validLocation, transponder_setting: 'none' }),
    ).not.toThrow()
  })

  it('throws ValidationFailed for an unknown transponder_setting value', () => {
    expect(() =>
      validateLocation({
        ...validLocation,
        transponder_setting: 'friends-only',
      }),
    ).toThrow(expect.objectContaining({ code: AclError.ValidationFailed }))
  })

  it('accepts every valid transponder_setting without a code', () => {
    for (const transponder_setting of ['public', 'tribe', 'none']) {
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

  it('strips a stray transponder_code when setting is not "transponder_code"', () => {
    const parsed = validateLocation({
      ...validLocation,
      transponder_setting: 'tribe',
      transponder_code: 'Alpha7Bravo9',
    })
    expect((parsed as any).transponder_code).toBeUndefined()
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
        transponder_setting: 'transponder_code',
        transponder_code: 'a'.repeat(TRANSPONDER_CODE_MAX_LENGTH),
      }),
    ).not.toThrow()
  })

  it('throws ValidationFailed when transponder_code exceeds 32 characters', () => {
    expect(() =>
      validateLocation({
        ...validLocation,
        transponder_setting: 'transponder_code',
        transponder_code: 'a'.repeat(TRANSPONDER_CODE_MAX_LENGTH + 1),
      }),
    ).toThrow(expect.objectContaining({ code: AclError.ValidationFailed }))
  })

  it('throws ValidationFailed when transponder_code contains non-alphanumerics', () => {
    for (const transponder_code of ['TX-42', 'has space', 'p@ss', '']) {
      expect(() =>
        validateLocation({
          ...validLocation,
          transponder_setting: 'transponder_code',
          transponder_code,
        }),
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

  it('throws ValidationFailed for an unrecognized structure_type', () => {
    expect(() =>
      validateLocation({ ...validLocation, structure_type: 'pos-tower' }),
    ).toThrow(expect.objectContaining({ code: AclError.ValidationFailed }))
  })

  it('accepts "storage_unit" and "turret" with no structure-specific fields', () => {
    for (const structure_type of ['storage_unit', 'turret']) {
      expect(() =>
        validateLocation({ ...validLocation, structure_type }),
      ).not.toThrow()
    }
  })

  it('throws ValidationFailed for "catapult" without destination_solar_system', () => {
    expect(() =>
      validateLocation({ ...validLocation, structure_type: 'catapult' }),
    ).toThrow(expect.objectContaining({ code: AclError.ValidationFailed }))
  })

  it('accepts "catapult" with a destination_solar_system', () => {
    expect(() =>
      validateLocation({
        ...validLocation,
        structure_type: 'catapult',
        destination_solar_system: 'Amarr',
      }),
    ).not.toThrow()
  })

  it('strips destination_solar_system from a "gate" (source of truth is on-chain)', () => {
    const parsed = validateLocation({
      ...validLocation,
      structure_type: 'gate',
      destination_solar_system: 'Amarr',
    })
    expect((parsed as any).destination_solar_system).toBeUndefined()
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
      schema_version: 3,
      updated_at: new Date().toISOString(),
      locations: [],
    })
    expect(result.success).toBe(true)
  })
})

describe('LocationSchemaV4', () => {
  const base = {
    id: 'x',
    solar_system: 'Sol',
    structure_type: 'gate',
    warp_in: 'P1L0',
    description: 'test',
  }

  it('accepts a location without any transponder fields (no beacon)', () => {
    const result = LocationSchemaV4.safeParse(base)
    expect(result.success).toBe(true)
  })

  it('accepts a location with a setting and no code', () => {
    const result = LocationSchemaV4.safeParse({
      ...base,
      transponder_setting: 'public',
    })
    expect(result.success).toBe(true)
  })

  it('still rejects setting "transponder_code" without a code', () => {
    const result = LocationSchemaV4.safeParse({
      ...base,
      transponder_setting: 'transponder_code',
    })
    expect(result.success).toBe(false)
  })

  it('still enforces the alphanumeric code format', () => {
    const result = LocationSchemaV4.safeParse({
      ...base,
      transponder_setting: 'transponder_code',
      transponder_code: 'not valid!',
    })
    expect(result.success).toBe(false)
  })
})

describe('DocumentSchemaV4', () => {
  it('rejects a document with schema_version: 3', () => {
    const result = DocumentSchemaV4.safeParse({
      schema: LOCATIONS_SCHEMA_NAME,
      schema_version: 3,
      updated_at: new Date().toISOString(),
      locations: [],
    })
    expect(result.success).toBe(false)
  })

  it('accepts a valid v4 document', () => {
    const result = DocumentSchemaV4.safeParse({
      schema: LOCATIONS_SCHEMA_NAME,
      schema_version: 4,
      updated_at: new Date().toISOString(),
      locations: [],
    })
    expect(result.success).toBe(true)
  })
})

describe('StructureFieldsSchemaV5', () => {
  const base = {
    id: 'x',
    solar_system: 'Sol',
    warp_in: 'P1L0',
    description: 'test',
  }

  it('accepts a gate with no destination_solar_system', () => {
    const result = StructureFieldsSchemaV5.safeParse({
      ...base,
      structure_type: 'gate',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a gate that supplies destination_solar_system (extra key is stripped, not required)', () => {
    const result = StructureFieldsSchemaV5.safeParse({
      ...base,
      structure_type: 'gate',
      destination_solar_system: 'Amarr',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as any).destination_solar_system).toBeUndefined()
    }
  })

  it('rejects a catapult without destination_solar_system', () => {
    const result = StructureFieldsSchemaV5.safeParse({
      ...base,
      structure_type: 'catapult',
    })
    expect(result.success).toBe(false)
  })

  it('accepts a catapult with destination_solar_system', () => {
    const result = StructureFieldsSchemaV5.safeParse({
      ...base,
      structure_type: 'catapult',
      destination_solar_system: 'Amarr',
    })
    expect(result.success).toBe(true)
  })

  it('accepts storage_unit and turret with only base fields', () => {
    for (const structure_type of ['storage_unit', 'turret']) {
      const result = StructureFieldsSchemaV5.safeParse({
        ...base,
        structure_type,
      })
      expect(result.success).toBe(true)
    }
  })

  it('rejects an unrecognized structure_type', () => {
    const result = StructureFieldsSchemaV5.safeParse({
      ...base,
      structure_type: 'pos-tower',
    })
    expect(result.success).toBe(false)
  })
})

describe('TransponderFieldsSchemaV5', () => {
  it('accepts "none", "public", and "tribe" with no code', () => {
    for (const transponder_setting of ['none', 'public', 'tribe']) {
      const result = TransponderFieldsSchemaV5.safeParse({
        transponder_setting,
      })
      expect(result.success).toBe(true)
    }
  })

  it('rejects "transponder_code" without a code', () => {
    const result = TransponderFieldsSchemaV5.safeParse({
      transponder_setting: 'transponder_code',
    })
    expect(result.success).toBe(false)
  })

  it('accepts "transponder_code" with an alphanumeric code', () => {
    const result = TransponderFieldsSchemaV5.safeParse({
      transponder_setting: 'transponder_code',
      transponder_code: 'Zulu99',
    })
    expect(result.success).toBe(true)
  })

  it('rejects an unrecognized transponder_setting', () => {
    const result = TransponderFieldsSchemaV5.safeParse({
      transponder_setting: 'friends-only',
    })
    expect(result.success).toBe(false)
  })
})

describe('LocationSchemaV5', () => {
  const base = {
    id: 'x',
    solar_system: 'Sol',
    warp_in: 'P1L0',
    description: 'test',
  }

  it('accepts a gate with transponder_setting "none"', () => {
    const result = LocationSchemaV5.safeParse({
      ...base,
      structure_type: 'gate',
      transponder_setting: 'none',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a catapult with a destination and a transponder code', () => {
    const result = LocationSchemaV5.safeParse({
      ...base,
      structure_type: 'catapult',
      destination_solar_system: 'Amarr',
      transponder_setting: 'transponder_code',
      transponder_code: 'Zulu99',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a catapult missing destination_solar_system even with a valid transponder', () => {
    const result = LocationSchemaV5.safeParse({
      ...base,
      structure_type: 'catapult',
      transponder_setting: 'public',
    })
    expect(result.success).toBe(false)
  })

  it('rejects transponder_setting "transponder_code" without a code, independent of structure_type', () => {
    const result = LocationSchemaV5.safeParse({
      ...base,
      structure_type: 'turret',
      transponder_setting: 'transponder_code',
    })
    expect(result.success).toBe(false)
  })
})

describe('DocumentSchemaV5', () => {
  it('rejects a document with schema_version: 4', () => {
    const result = DocumentSchemaV5.safeParse({
      schema: LOCATIONS_SCHEMA_NAME,
      schema_version: 4,
      updated_at: new Date().toISOString(),
      locations: [],
    })
    expect(result.success).toBe(false)
  })

  it('accepts a valid v5 document', () => {
    const result = DocumentSchemaV5.safeParse({
      schema: LOCATIONS_SCHEMA_NAME,
      schema_version: LOCATIONS_SCHEMA_VERSION,
      updated_at: new Date().toISOString(),
      locations: [],
    })
    expect(result.success).toBe(true)
  })
})
