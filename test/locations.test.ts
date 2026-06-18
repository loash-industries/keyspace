import { jest, describe, it, expect } from '@jest/globals'
import {
  LocationsClient,
  LOCATIONS_SCHEMA_NAME,
  LOCATIONS_SCHEMA_VERSION,
  type LocationsDocument,
  type Location,
} from '../src/locations'
import type { AclClient } from '../src/AclClient'
import { AclError } from '../src/errors'

// ── Constants ─────────────────────────────────────────────────────────────────

const ACL_ID =
  '0x0000000000000000000000000000000000000000000000000000000000001001'
const ENTRY_ID =
  '0x0000000000000000000000000000000000000000000000000000000000001002'
const DAO_ID =
  '0x0000000000000000000000000000000000000000000000000000000000001003'
const WALLET =
  '0x0000000000000000000000000000000000000000000000000000000000001004'

const SIGN_FN = (jest.fn() as any).mockResolvedValue('sig')

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLocation(overrides: Partial<Location> = {}): Location {
  return {
    id: 'loc-1',
    solar_system: 'Sol',
    warp_in: '0,0,0',
    description: 'Test location',
    ...overrides,
  }
}

function makeDoc(
  locations: Location[] = [],
  overrides: Partial<LocationsDocument> = {},
): LocationsDocument {
  return {
    schema: LOCATIONS_SCHEMA_NAME,
    schema_version: LOCATIONS_SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
    locations,
    ...overrides,
  }
}

function encodeDoc(doc: LocationsDocument): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(doc))
}

function makeAclClient(overrides: Record<string, any> = {}) {
  return {
    readData: jest.fn() as any,
    editData: (jest.fn() as any).mockResolvedValue({
      entryId: ENTRY_ID,
      uri: 'ipfs://cid',
      epoch: 1,
    }),
    writeData: (jest.fn() as any).mockResolvedValue({
      entryId: ENTRY_ID,
      uri: 'ipfs://cid',
      epoch: 1,
    }),
    rotateEntry: (jest.fn() as any).mockResolvedValue({
      newUri: 'ipfs://new',
      epoch: 2,
    }),
    ...overrides,
  }
}

function makeClient(aclClient = makeAclClient()) {
  return new LocationsClient({
    aclClient: aclClient as unknown as AclClient,
    aclId: ACL_ID,
    entryId: ENTRY_ID,
    walletAddress: WALLET,
    signPersonalMessage: SIGN_FN,
    daoId: DAO_ID,
  })
}

// ── download ──────────────────────────────────────────────────────────────────

describe('download', () => {
  it('decodes and returns a valid locations document', async () => {
    const doc = makeDoc([makeLocation()])
    const aclClient = makeAclClient({
      readData: (jest.fn() as any).mockResolvedValue(encodeDoc(doc)),
    })
    const client = makeClient(aclClient)

    const result = await client.download()

    expect(result.schema).toBe(LOCATIONS_SCHEMA_NAME)
    expect(result.locations).toHaveLength(1)
  })

  it('throws UnexpectedResponse when schema name does not match', async () => {
    const doc = makeDoc([], { schema: 'wrong.schema' as any })
    const aclClient = makeAclClient({
      readData: (jest.fn() as any).mockResolvedValue(encodeDoc(doc)),
    })
    const client = makeClient(aclClient)

    await expect(client.download()).rejects.toMatchObject({
      code: AclError.UnexpectedResponse,
    })
  })

  it('throws UnexpectedResponse when schema_version does not match', async () => {
    const doc = makeDoc([], { schema_version: 99 as any })
    const aclClient = makeAclClient({
      readData: (jest.fn() as any).mockResolvedValue(encodeDoc(doc)),
    })
    const client = makeClient(aclClient)

    await expect(client.download()).rejects.toMatchObject({
      code: AclError.UnexpectedResponse,
    })
  })

  it('passes daoId through to readData', async () => {
    const doc = makeDoc()
    const aclClient = makeAclClient({
      readData: (jest.fn() as any).mockResolvedValue(encodeDoc(doc)),
    })
    const client = makeClient(aclClient)

    await client.download()

    expect(aclClient.readData).toHaveBeenCalledWith(
      expect.objectContaining({ daoId: DAO_ID }),
    )
  })
})

// ── addLocation ───────────────────────────────────────────────────────────────

describe('addLocation', () => {
  it('appends the location and calls editData', async () => {
    const existing = makeLocation({ id: 'a' })
    const newLoc = makeLocation({ id: 'b' })
    const doc = makeDoc([existing])
    const aclClient = makeAclClient({
      readData: (jest.fn() as any).mockResolvedValue(encodeDoc(doc)),
    })
    const client = makeClient(aclClient)

    await client.addLocation(newLoc)

    expect(aclClient.editData).toHaveBeenCalledTimes(1)
    const call = aclClient.editData.mock.calls[0][0]
    const saved: LocationsDocument = JSON.parse(call.newPlaintext)
    expect(saved.locations).toHaveLength(2)
    expect(saved.locations[1].id).toBe('b')
  })

  it('throws UnexpectedResponse when location id already exists', async () => {
    const loc = makeLocation({ id: 'dup' })
    const doc = makeDoc([loc])
    const aclClient = makeAclClient({
      readData: (jest.fn() as any).mockResolvedValue(encodeDoc(doc)),
    })
    const client = makeClient(aclClient)

    await expect(
      client.addLocation(makeLocation({ id: 'dup' })),
    ).rejects.toMatchObject({
      code: AclError.UnexpectedResponse,
    })
  })

  it('returns the WriteResult from editData', async () => {
    const doc = makeDoc()
    const aclClient = makeAclClient({
      readData: (jest.fn() as any).mockResolvedValue(encodeDoc(doc)),
      editData: (jest.fn() as any).mockResolvedValue({
        entryId: ENTRY_ID,
        uri: 'ipfs://x',
        epoch: 5,
      }),
    })
    const client = makeClient(aclClient)

    const result = await client.addLocation(makeLocation())

    expect(result).toEqual({ entryId: ENTRY_ID, uri: 'ipfs://x', epoch: 5 })
  })
})

// ── updateLocation ────────────────────────────────────────────────────────────

describe('updateLocation', () => {
  it('updates the matching location and calls editData', async () => {
    const loc = makeLocation({ id: 'x', description: 'old' })
    const doc = makeDoc([loc])
    const aclClient = makeAclClient({
      readData: (jest.fn() as any).mockResolvedValue(encodeDoc(doc)),
    })
    const client = makeClient(aclClient)

    await client.updateLocation('x', { description: 'new' })

    const call = aclClient.editData.mock.calls[0][0]
    const saved: LocationsDocument = JSON.parse(call.newPlaintext)
    expect(saved.locations[0].description).toBe('new')
    expect(saved.locations[0].id).toBe('x')
  })

  it('throws UnexpectedResponse when location id is not found', async () => {
    const doc = makeDoc([makeLocation({ id: 'exists' })])
    const aclClient = makeAclClient({
      readData: (jest.fn() as any).mockResolvedValue(encodeDoc(doc)),
    })
    const client = makeClient(aclClient)

    await expect(
      client.updateLocation('missing', { description: 'x' }),
    ).rejects.toMatchObject({
      code: AclError.UnexpectedResponse,
    })
  })
})

// ── removeLocation ────────────────────────────────────────────────────────────

describe('removeLocation', () => {
  it('removes the matching location and calls editData', async () => {
    const loc1 = makeLocation({ id: 'keep' })
    const loc2 = makeLocation({ id: 'remove' })
    const doc = makeDoc([loc1, loc2])
    const aclClient = makeAclClient({
      readData: (jest.fn() as any).mockResolvedValue(encodeDoc(doc)),
    })
    const client = makeClient(aclClient)

    await client.removeLocation('remove')

    const call = aclClient.editData.mock.calls[0][0]
    const saved: LocationsDocument = JSON.parse(call.newPlaintext)
    expect(saved.locations).toHaveLength(1)
    expect(saved.locations[0].id).toBe('keep')
  })

  it('throws UnexpectedResponse when location id is not found', async () => {
    const doc = makeDoc([makeLocation({ id: 'exists' })])
    const aclClient = makeAclClient({
      readData: (jest.fn() as any).mockResolvedValue(encodeDoc(doc)),
    })
    const client = makeClient(aclClient)

    await expect(client.removeLocation('missing')).rejects.toMatchObject({
      code: AclError.UnexpectedResponse,
    })
  })
})

// ── reencrypt ─────────────────────────────────────────────────────────────────

describe('reencrypt', () => {
  it('delegates to aclClient.rotateEntry and returns the result', async () => {
    const aclClient = makeAclClient()
    const client = makeClient(aclClient)

    const result = await client.reencrypt()

    expect(aclClient.rotateEntry).toHaveBeenCalledWith(
      expect.objectContaining({ aclId: ACL_ID, entryId: ENTRY_ID }),
    )
    expect(result).toEqual({ newUri: 'ipfs://new', epoch: 2 })
  })
})

// ── LocationsClient.create ────────────────────────────────────────────────────

describe('LocationsClient.create', () => {
  it('writes an empty document and returns a LocationsClient', async () => {
    const aclClient = makeAclClient()
    const client = await LocationsClient.create({
      aclClient: aclClient as unknown as AclClient,
      aclId: ACL_ID,
      walletAddress: WALLET,
      signPersonalMessage: SIGN_FN,
      daoId: DAO_ID,
    })

    expect(aclClient.writeData).toHaveBeenCalledTimes(1)
    const call = aclClient.writeData.mock.calls[0][0]
    const doc: LocationsDocument = JSON.parse(call.plaintext)
    expect(doc.schema).toBe(LOCATIONS_SCHEMA_NAME)
    expect(doc.schema_version).toBe(LOCATIONS_SCHEMA_VERSION)
    expect(doc.locations).toEqual([])
    expect(client).toBeInstanceOf(LocationsClient)
  })

  it('uses the entryId from writeData result', async () => {
    const aclClient = makeAclClient({
      writeData: (jest.fn() as any).mockResolvedValue({
        entryId: '0xnewentry',
        uri: 'ipfs://x',
        epoch: 0,
      }),
    })
    const client = await LocationsClient.create({
      aclClient: aclClient as unknown as AclClient,
      aclId: ACL_ID,
      walletAddress: WALLET,
      signPersonalMessage: SIGN_FN,
      daoId: DAO_ID,
    })

    // Verify the returned client uses the new entryId by calling reencrypt
    await client.reencrypt()
    expect(aclClient.rotateEntry).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: '0xnewentry' }),
    )
  })
})
