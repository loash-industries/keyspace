import { jest } from '@jest/globals'
import {
  fetchKeyspaceMeta,
  fetchKeyspaceDetail,
  fetchEncryptedEntry,
  fetchAccessibleKeyspaces,
} from '../src/queries'
import { AclError, AclClientError } from '../src/errors'

// ── Helpers ───────────────────────────────────────────────────────────────────

const ACL_ID = '0xacl001'
const ENTRY_ID = '0xentry01'
const OWNER = '0xowner'
const MEMBER1 =
  '0x0000000000000000000000000000000000000000000000000000000000001001'
const MEMBER2 =
  '0x0000000000000000000000000000000000000000000000000000000000001002'
const DAO_ID =
  '0x0000000000000000000000000000000000000000000000000000000000002001'

function makeSuiClient(overrides: Record<string, jest.Mock> = {}) {
  return {
    getObject: jest.fn() as jest.Mock,
    multiGetObjects: jest.fn() as jest.Mock,
    ...overrides,
  }
}

function moveObjectResponse(id: string, fields: Record<string, unknown>) {
  return {
    data: {
      objectId: id,
      content: { dataType: 'moveObject', fields },
    },
  }
}

function makeKeyspaceFields(overrides: Record<string, unknown> = {}) {
  return {
    name: 'My Keyspace',
    version: 1,
    entries: [],
    acl: { contents: [] },
    ...overrides,
  }
}

// ── fetchKeyspaceMeta ─────────────────────────────────────────────────────────

describe('fetchKeyspaceMeta', () => {
  it('returns null when content is not moveObject', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue({
        data: { content: { dataType: 'package' } },
      }),
    })
    const result = await fetchKeyspaceMeta(client, ACL_ID)
    expect(result).toBeNull()
  })

  it('returns AclMeta for a valid keyspace object', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(
          ACL_ID,
          makeKeyspaceFields({
            name: 'My Keyspace',
            version: 3,
            entries: ['e1', 'e2'],
          }),
        ),
      ),
    })
    const result = await fetchKeyspaceMeta(client, ACL_ID)
    expect(result).toEqual({
      id: ACL_ID,
      name: 'My Keyspace',
      epoch: 3,
      entryCount: 2,
    })
  })

  it('defaults epoch to 0 when version is missing', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(ACL_ID, {
          name: 'My Keyspace',
          entries: [],
          acl: { contents: [] },
        }),
      ),
    })
    const result = await fetchKeyspaceMeta(client, ACL_ID)
    expect(result?.epoch).toBe(0)
  })
})

// ── fetchKeyspaceDetail ───────────────────────────────────────────────────────

describe('fetchKeyspaceDetail', () => {
  it('returns null when content is not moveObject', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue({
        data: { content: { dataType: 'package' } },
      }),
      multiGetObjects: (jest.fn() as any).mockResolvedValue([]),
    })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    expect(result).toBeNull()
  })

  it('returns AclDetail with empty principals when acl is empty', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(
          ACL_ID,
          makeKeyspaceFields({
            name: 'Shared ACL',
            version: 2,
            acl: { contents: [] },
          }),
        ),
      ),
      multiGetObjects: (jest.fn() as any).mockResolvedValue([]),
    })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    expect(result).not.toBeNull()
    expect(result!.id).toBe(ACL_ID)
    expect(result!.name).toBe('Shared ACL')
    expect(result!.epoch).toBe(2)
    expect(result!.grantPrincipals).toEqual([])
    expect(result!.readPrincipals).toEqual([])
    expect(result!.writePrincipals).toEqual([])
    expect(result!.entries).toEqual([])
  })

  it('parses Player principals from acl.contents', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(
          ACL_ID,
          makeKeyspaceFields({
            version: 1,
            acl: {
              contents: [
                {
                  key: 'Read',
                  value: [
                    { Player: { addr: MEMBER1 } },
                    { Player: { addr: MEMBER2 } },
                  ],
                },
              ],
            },
          }),
        ),
      ),
      multiGetObjects: (jest.fn() as any).mockResolvedValue([]),
    })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    expect(result!.readPrincipals).toEqual([
      { type: 'player', address: MEMBER1 },
      { type: 'player', address: MEMBER2 },
    ])
    expect(result!.roles).toEqual(result!.readPrincipals)
  })

  it('ignores unrecognised principal shapes in acl.contents', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(
          ACL_ID,
          makeKeyspaceFields({
            acl: {
              contents: [
                {
                  key: 'Read',
                  value: [
                    { UnknownVariant: {} },
                    null,
                    42,
                    { Player: { addr: MEMBER1 } },
                  ],
                },
              ],
            },
          }),
        ),
      ),
      multiGetObjects: (jest.fn() as any).mockResolvedValue([]),
    })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    // Only the valid Player entry survives; unknown shapes are silently dropped
    expect(result!.readPrincipals).toEqual([
      { type: 'player', address: MEMBER1 },
    ])
  })

  it('parses Write principals from acl.contents', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(
          ACL_ID,
          makeKeyspaceFields({
            acl: {
              contents: [
                { key: 'Write', value: [{ Player: { addr: MEMBER1 } }] },
              ],
            },
          }),
        ),
      ),
      multiGetObjects: (jest.fn() as any).mockResolvedValue([]),
    })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    expect(result!.writePrincipals).toEqual([
      { type: 'player', address: MEMBER1 },
    ])
    expect(result!.readPrincipals).toEqual([])
    expect(result!.grantPrincipals).toEqual([])
  })

  it('parses Ou principals from acl.contents', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(
          ACL_ID,
          makeKeyspaceFields({
            version: 1,
            acl: {
              contents: [{ key: 'Grant', value: [{ Ou: { dao_id: DAO_ID } }] }],
            },
          }),
        ),
      ),
      multiGetObjects: (jest.fn() as any).mockResolvedValue([]),
    })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    expect(result!.grantPrincipals).toEqual([{ type: 'ou', daoId: DAO_ID }])
  })

  it('includes fetched entries in the detail', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(
          ACL_ID,
          makeKeyspaceFields({
            version: 5,
            entries: [ENTRY_ID],
          }),
        ),
      ),
      multiGetObjects: (jest.fn() as any).mockResolvedValue([
        {
          data: {
            objectId: ENTRY_ID,
            content: {
              dataType: 'moveObject',
              fields: {
                keyspace_id: ACL_ID,
                uri: 'ipfs://QmABC',
                description: 'test entry',
                created_by: OWNER,
                epoch: 5,
              },
            },
          },
        },
      ]),
    })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    expect(result!.entries).toHaveLength(1)
    expect(result!.entries[0]).toMatchObject({
      id: ENTRY_ID,
      keyspaceId: ACL_ID,
      uri: 'ipfs://QmABC',
      description: 'test entry',
      epoch: 5,
      isStale: false,
    })
  })
})

// ── fetchEncryptedEntry ───────────────────────────────────────────────────────

describe('fetchEncryptedEntry', () => {
  it('returns null when content is not moveObject', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue({
        data: { content: { dataType: 'package' } },
      }),
    })
    const result = await fetchEncryptedEntry(client, ENTRY_ID, 1)
    expect(result).toBeNull()
  })

  it('marks entry as not stale when entry epoch equals keyspace epoch', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(ENTRY_ID, {
          keyspace_id: ACL_ID,
          uri: 'ipfs://QmXYZ',
          description: 'data',
          created_by: OWNER,
          epoch: 3,
        }),
      ),
    })
    const result = await fetchEncryptedEntry(client, ENTRY_ID, 3)
    expect(result!.isStale).toBe(false)
    expect(result!.epoch).toBe(3)
  })

  it('marks entry as stale when entry epoch is less than keyspace epoch', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(ENTRY_ID, {
          keyspace_id: ACL_ID,
          uri: 'ipfs://QmXYZ',
          description: 'data',
          created_by: OWNER,
          epoch: 1,
        }),
      ),
    })
    const result = await fetchEncryptedEntry(client, ENTRY_ID, 3)
    expect(result!.isStale).toBe(true)
  })

  it('returns full EntryMeta fields', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(ENTRY_ID, {
          keyspace_id: ACL_ID,
          uri: 'ipfs://QmFULL',
          description: 'full entry',
          created_by: OWNER,
          epoch: '2',
        }),
      ),
    })
    const result = await fetchEncryptedEntry(client, ENTRY_ID, 2)
    expect(result).toEqual({
      id: ENTRY_ID,
      keyspaceId: ACL_ID,
      uri: 'ipfs://QmFULL',
      description: 'full entry',
      createdBy: OWNER,
      epoch: 2,
      isStale: false,
    })
  })
})

// ── fetchAccessibleKeyspaces ──────────────────────────────────────────────────

describe('fetchAccessibleKeyspaces', () => {
  const INDEXER = 'https://indexer.example.com'

  let fetchMock: any

  beforeEach(() => {
    fetchMock = jest.fn()
    ;(global as any).fetch = fetchMock
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('returns keyspaceIds from the indexer', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ keyspaceIds: ['0xacl1', '0xacl2'] }),
    })
    const result = await fetchAccessibleKeyspaces(INDEXER, OWNER)
    expect(result).toEqual(['0xacl1', '0xacl2'])
    expect(fetchMock).toHaveBeenCalledWith(
      `${INDEXER}/v1/address/${OWNER}/keyspaces`,
    )
  })

  it('throws AclClientError(UnexpectedResponse) on non-ok response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    })
    await expect(fetchAccessibleKeyspaces(INDEXER, OWNER)).rejects.toThrow(
      AclClientError,
    )
    await expect(
      fetchAccessibleKeyspaces(INDEXER, OWNER),
    ).rejects.toMatchObject({
      code: AclError.UnexpectedResponse,
    })
  })
})
