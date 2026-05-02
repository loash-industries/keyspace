import { jest } from '@jest/globals'
import {
  fetchAdminCaps,
  fetchAllowListMeta,
  fetchAllowListDetail,
  fetchEncryptedEntry,
  fetchAccessibleAcls,
} from '../src/queries'
import { AclError, AclClientError } from '../src/errors'

// ── Helpers ───────────────────────────────────────────────────────────────────

const PKG = '0xpkg'
const ACL_ID = '0xacl001'
const ENTRY_ID = '0xentry01'
const OWNER = '0xowner'

function makeSuiClient(overrides: Record<string, jest.Mock> = {}) {
  return {
    getOwnedObjects: jest.fn() as jest.Mock,
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

// ── fetchAdminCaps ────────────────────────────────────────────────────────────

describe('fetchAdminCaps', () => {
  it('returns an empty array when no objects are returned', async () => {
    const client = makeSuiClient({
      getOwnedObjects: (jest.fn() as any).mockResolvedValue({ data: [] }),
    })
    const result = await fetchAdminCaps(client, PKG, OWNER)
    expect(result).toEqual([])
    expect(client.getOwnedObjects).toHaveBeenCalledWith({
      owner: OWNER,
      filter: { StructType: `${PKG}::acl_encrypt::AdminCap` },
      options: { showContent: true },
    })
  })

  it('returns AdminCap objects from the response', async () => {
    const client = makeSuiClient({
      getOwnedObjects: (jest.fn() as any).mockResolvedValue({
        data: [
          {
            data: {
              objectId: '0xcap1',
              content: {
                dataType: 'moveObject',
                fields: { allowlist_id: ACL_ID },
              },
            },
          },
          {
            data: {
              objectId: '0xcap2',
              content: {
                dataType: 'moveObject',
                fields: { allowlist_id: '0xacl002' },
              },
            },
          },
        ],
      }),
    })
    const result = await fetchAdminCaps(client, PKG, OWNER)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ id: '0xcap1', aclId: ACL_ID })
    expect(result[1]).toEqual({ id: '0xcap2', aclId: '0xacl002' })
  })

  it('filters out non-moveObject entries', async () => {
    const client = makeSuiClient({
      getOwnedObjects: (jest.fn() as any).mockResolvedValue({
        data: [
          { data: { objectId: '0xcap1', content: { dataType: 'package' } } },
        ],
      }),
    })
    const result = await fetchAdminCaps(client, PKG, OWNER)
    expect(result).toEqual([])
  })
})

// ── fetchAllowListMeta ────────────────────────────────────────────────────────

describe('fetchAllowListMeta', () => {
  it('returns null when content is not moveObject', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue({
        data: { content: { dataType: 'package' } },
      }),
    })
    const result = await fetchAllowListMeta(client, ACL_ID)
    expect(result).toBeNull()
  })

  it('returns AclMeta for a valid allowlist object', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(ACL_ID, {
          owner: OWNER,
          name: 'My ACL',
          version: 3,
          entries: ['e1', 'e2'],
          list: { fields: { contents: [] } },
        }),
      ),
    })
    const result = await fetchAllowListMeta(client, ACL_ID)
    expect(result).toEqual({
      id: ACL_ID,
      owner: OWNER,
      name: 'My ACL',
      epoch: 3,
      entryCount: 2,
    })
  })

  it('defaults epoch to 0 when version is missing', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(ACL_ID, {
          owner: OWNER,
          name: 'My ACL',
          entries: [],
          list: { fields: { contents: [] } },
        }),
      ),
    })
    const result = await fetchAllowListMeta(client, ACL_ID)
    expect(result?.epoch).toBe(0)
  })
})

// ── fetchAllowListDetail ──────────────────────────────────────────────────────

describe('fetchAllowListDetail', () => {
  it('returns null when content is not moveObject', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue({
        data: { content: { dataType: 'package' } },
      }),
      multiGetObjects: (jest.fn() as any).mockResolvedValue([]),
    })
    const result = await fetchAllowListDetail(client, PKG, ACL_ID)
    expect(result).toBeNull()
  })

  it('returns AclDetail with roles and entries', async () => {
    const member1 = '0xmember1'
    const member2 = '0xmember2'
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(ACL_ID, {
          owner: OWNER,
          name: 'Shared ACL',
          version: 2,
          entries: [],
          list: { fields: { contents: [member1, member2] } },
        }),
      ),
      multiGetObjects: (jest.fn() as any).mockResolvedValue([]),
    })
    const result = await fetchAllowListDetail(client, PKG, ACL_ID)
    expect(result).not.toBeNull()
    expect(result!.id).toBe(ACL_ID)
    expect(result!.owner).toBe(OWNER)
    expect(result!.name).toBe('Shared ACL')
    expect(result!.epoch).toBe(2)
    expect(result!.roles).toEqual([
      { type: 'address', address: member1 },
      { type: 'address', address: member2 },
    ])
    expect(result!.entries).toEqual([])
  })

  it('includes fetched entries in the detail', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(ACL_ID, {
          owner: OWNER,
          name: 'ACL',
          version: 5,
          entries: [ENTRY_ID],
          list: { fields: { contents: [] } },
        }),
      ),
      multiGetObjects: (jest.fn() as any).mockResolvedValue([
        {
          data: {
            objectId: ENTRY_ID,
            content: {
              dataType: 'moveObject',
              fields: {
                allowlist_id: ACL_ID,
                location: 'ipfs://QmABC',
                description: 'test entry',
                created_by: OWNER,
                epoch: 5,
              },
            },
          },
        },
      ]),
    })
    const result = await fetchAllowListDetail(client, PKG, ACL_ID)
    expect(result!.entries).toHaveLength(1)
    expect(result!.entries[0]).toMatchObject({
      id: ENTRY_ID,
      aclId: ACL_ID,
      location: 'ipfs://QmABC',
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

  it('marks entry as not stale when entry epoch equals acl epoch', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(ENTRY_ID, {
          allowlist_id: ACL_ID,
          location: 'ipfs://QmXYZ',
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

  it('marks entry as stale when entry epoch is less than acl epoch', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(ENTRY_ID, {
          allowlist_id: ACL_ID,
          location: 'ipfs://QmXYZ',
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
          allowlist_id: ACL_ID,
          location: 'ipfs://QmFULL',
          description: 'full entry',
          created_by: OWNER,
          epoch: '2',
        }),
      ),
    })
    const result = await fetchEncryptedEntry(client, ENTRY_ID, 2)
    expect(result).toEqual({
      id: ENTRY_ID,
      aclId: ACL_ID,
      location: 'ipfs://QmFULL',
      description: 'full entry',
      createdBy: OWNER,
      epoch: 2,
      isStale: false,
    })
  })
})

// ── fetchAccessibleAcls ───────────────────────────────────────────────────────

describe('fetchAccessibleAcls', () => {
  const INDEXER = 'https://indexer.example.com'

  let fetchMock: any

  beforeEach(() => {
    fetchMock = jest.fn()
    ;(global as any).fetch = fetchMock
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('returns aclIds from the indexer', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ aclIds: ['0xacl1', '0xacl2'] }),
    })
    const result = await fetchAccessibleAcls(INDEXER, OWNER)
    expect(result).toEqual(['0xacl1', '0xacl2'])
    expect(fetchMock).toHaveBeenCalledWith(
      `${INDEXER}/v1/address/${OWNER}/acls`,
    )
  })

  it('throws AclClientError(UnexpectedResponse) on non-ok response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    })
    await expect(fetchAccessibleAcls(INDEXER, OWNER)).rejects.toThrow(
      AclClientError,
    )
    await expect(fetchAccessibleAcls(INDEXER, OWNER)).rejects.toMatchObject({
      code: AclError.UnexpectedResponse,
    })
  })
})
