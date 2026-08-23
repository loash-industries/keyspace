import { describe, it, expect } from '@jest/globals'
import {
  MACHINES_SCHEMA_NAME,
  MACHINE_LABEL_MAX_LENGTH,
  MACHINE_NOTE_MAX_LENGTH,
  migrateMachinesDocument,
  normalizeMachineAddress,
  validateMachineRecord,
  type MachinesDocument,
} from '../src/machines-schemas'
import { AclClientError } from '../src/errors'

const ADDR =
  '0x00000000000000000000000000000000000000000000000000000000000000aa'
const OWNER =
  '0x00000000000000000000000000000000000000000000000000000000000000bb'

function makeDocument(
  overrides: Partial<MachinesDocument> = {},
): MachinesDocument {
  return {
    schema: MACHINES_SCHEMA_NAME,
    schema_version: 1,
    updated_at: '2026-08-23T00:00:00.000Z',
    machines: {
      [ADDR]: {
        label: 'estuary discord enricher',
        added_by: OWNER,
        added_at: '2026-08-23T00:00:00.000Z',
      },
    },
    ...overrides,
  }
}

describe('normalizeMachineAddress', () => {
  it('lowercases a valid mixed-case address', () => {
    expect(
      normalizeMachineAddress(ADDR.toUpperCase().replace('0X', '0x')),
    ).toBe(ADDR)
  })

  it('rejects a short address', () => {
    expect(() => normalizeMachineAddress('0x1234')).toThrow(AclClientError)
  })

  it('rejects non-hex input — a pasted private key can never become a row key', () => {
    expect(() =>
      normalizeMachineAddress('suiprivkey1qqqqqqqqqqqqqqqqqqqqqqqq'),
    ).toThrow(AclClientError)
  })
})

describe('validateMachineRecord', () => {
  it('accepts a record with label, added_by, added_at', () => {
    const record = validateMachineRecord({
      label: 'hauling bot',
      added_by: OWNER,
      added_at: '2026-08-23T00:00:00.000Z',
    })
    expect(record.label).toBe('hauling bot')
  })

  it('accepts an optional note within the length cap', () => {
    const record = validateMachineRecord({
      label: 'bot',
      note: 'runs in backend-dev',
      added_by: OWNER,
      added_at: '2026-08-23T00:00:00.000Z',
    })
    expect(record.note).toBe('runs in backend-dev')
  })

  it('rejects an empty label', () => {
    expect(() =>
      validateMachineRecord({
        label: '',
        added_by: OWNER,
        added_at: '2026-08-23T00:00:00.000Z',
      }),
    ).toThrow(AclClientError)
  })

  it('rejects a label over the cap', () => {
    expect(() =>
      validateMachineRecord({
        label: 'x'.repeat(MACHINE_LABEL_MAX_LENGTH + 1),
        added_by: OWNER,
        added_at: '2026-08-23T00:00:00.000Z',
      }),
    ).toThrow(AclClientError)
  })

  it('rejects a note over the cap', () => {
    expect(() =>
      validateMachineRecord({
        label: 'bot',
        note: 'x'.repeat(MACHINE_NOTE_MAX_LENGTH + 1),
        added_by: OWNER,
        added_at: '2026-08-23T00:00:00.000Z',
      }),
    ).toThrow(AclClientError)
  })
})

describe('migrateMachinesDocument', () => {
  it('accepts a valid v1 document unchanged', () => {
    const doc = makeDocument()
    expect(migrateMachinesDocument(doc)).toEqual(doc)
  })

  it('accepts an empty machines map', () => {
    const doc = makeDocument({ machines: {} })
    expect(migrateMachinesDocument(doc)).toEqual(doc)
  })

  it('rejects a document with the wrong schema name', () => {
    expect(() =>
      migrateMachinesDocument(
        makeDocument({ schema: 'triex.locations' as never }),
      ),
    ).toThrow(AclClientError)
  })

  it('rejects a document keyed by a non-address', () => {
    expect(() =>
      migrateMachinesDocument(
        makeDocument({
          machines: {
            'not-an-address': {
              label: 'bot',
              added_by: OWNER,
              added_at: '2026-08-23T00:00:00.000Z',
            },
          } as never,
        }),
      ),
    ).toThrow(AclClientError)
  })

  it('rejects arbitrary JSON', () => {
    expect(() => migrateMachinesDocument({ hello: 'world' })).toThrow(
      AclClientError,
    )
  })
})
