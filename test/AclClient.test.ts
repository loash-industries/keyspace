import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import type {
  AclClientConfig,
  AclDetail,
  AclMeta,
  EntryMeta,
} from '../src/types'
import { AclError } from '../src/errors'

// ── Mock functions (defined before unstable_mockModule calls) ─────────────────

const mockFetchAdminCaps = jest.fn() as any
const mockFetchAllowListMeta = jest.fn() as any
const mockFetchAllowListDetail = jest.fn() as any
const mockFetchEncryptedEntry = jest.fn() as any
const mockFetchAccessibleAcls = jest.fn() as any
const mockSealEncrypt = jest.fn() as any
const mockSealDecrypt = jest.fn() as any

// ── Module mocks (must precede dynamic imports) ────────────────────────────────

jest.unstable_mockModule('../src/queries', () => ({
  fetchAdminCaps: mockFetchAdminCaps,
  fetchAllowListMeta: mockFetchAllowListMeta,
  fetchAllowListDetail: mockFetchAllowListDetail,
  fetchEncryptedEntry: mockFetchEncryptedEntry,
  fetchAccessibleAcls: mockFetchAccessibleAcls,
}))

jest.unstable_mockModule('../src/seal_helpers', () => ({
  sealEncrypt: mockSealEncrypt,
  sealDecrypt: mockSealDecrypt,
  clearSessionCache: jest.fn(),
}))

// ── Dynamic imports after mock registration ────────────────────────────────────

const { AclClient } = await import('../src/AclClient')

// ── Valid Sui addresses (32 bytes = 64 hex chars) ─────────────────────────────

const PKG = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
const ACL_ID =
  '0x0000000000000000000000000000000000000000000000000000000000001001'
const CAP_ID =
  '0x0000000000000000000000000000000000000000000000000000000000001002'
const ENTRY_ID =
  '0x0000000000000000000000000000000000000000000000000000000000001003'
const OWNER =
  '0x0000000000000000000000000000000000000000000000000000000000001004'
const MEMBER =
  '0x0000000000000000000000000000000000000000000000000000000000001005'
const INDEXER = 'https://indexer.example.com'
const CID = 'QmTestCid'

const PLAINTEXT = new Uint8Array([1, 2, 3, 4, 5])
const ENCRYPTED = new Uint8Array([9, 8, 7])

// ── Mock builders ─────────────────────────────────────────────────────────────

function makeAclMeta(overrides: Partial<AclMeta> = {}): AclMeta {
  return {
    id: ACL_ID,
    owner: OWNER,
    name: 'Test ACL',
    epoch: 1,
    entryCount: 0,
    ...overrides,
  }
}

function makeAclDetail(overrides: Partial<AclDetail> = {}): AclDetail {
  return {
    ...makeAclMeta(),
    roles: [],
    entries: [],
    ...overrides,
  }
}

function makeEntry(overrides: Partial<EntryMeta> = {}): EntryMeta {
  return {
    id: ENTRY_ID,
    aclId: ACL_ID,
    location: `ipfs://${CID}`,
    description: 'test entry',
    createdBy: OWNER,
    epoch: 1,
    isStale: false,
    ...overrides,
  }
}

function makeStorageAdapter() {
  return {
    upload: (jest.fn() as any).mockResolvedValue(`ipfs://${CID}`),
    download: (jest.fn() as any).mockResolvedValue(ENCRYPTED),
  }
}

function makeExecutor() {
  return (jest.fn() as any).mockResolvedValue({
    digest: '0xdigest',
    objectChanges: [],
  })
}

function makeConfig(overrides: Partial<AclClientConfig> = {}): AclClientConfig {
  return {
    suiClient: {},
    sealClient: {},
    packageId: PKG,
    executor: makeExecutor(),
    storageAdapter: makeStorageAdapter(),
    ...overrides,
  }
}

function makeClient(overrides: Partial<AclClientConfig> = {}) {
  return new AclClient(makeConfig(overrides))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks()
})

// ── getAcl ────────────────────────────────────────────────────────────────────

describe('getAcl', () => {
  it('returns the ACL detail', async () => {
    const detail = makeAclDetail()
    mockFetchAllowListDetail.mockResolvedValue(detail)

    const client = makeClient()
    const result = await client.getAcl(ACL_ID)

    expect(result).toBe(detail)
    expect(mockFetchAllowListDetail).toHaveBeenCalledWith(
      expect.anything(),
      PKG,
      ACL_ID,
    )
  })

  it('throws AclClientError(EntryNotFound) when ACL does not exist', async () => {
    mockFetchAllowListDetail.mockResolvedValue(null)

    const client = makeClient()
    await expect(client.getAcl(ACL_ID)).rejects.toMatchObject({
      code: AclError.EntryNotFound,
    })
  })
})

// ── getOwnedAcls ──────────────────────────────────────────────────────────────

describe('getOwnedAcls', () => {
  it('delegates to fetchAdminCaps and returns the result', async () => {
    const caps = [{ id: CAP_ID, aclId: ACL_ID }]
    mockFetchAdminCaps.mockResolvedValue(caps)

    const client = makeClient()
    const result = await client.getOwnedAcls(OWNER)

    expect(result).toBe(caps)
    expect(mockFetchAdminCaps).toHaveBeenCalledWith(
      expect.anything(),
      PKG,
      OWNER,
    )
  })
})

// ── getAccessibleAcls ─────────────────────────────────────────────────────────

describe('getAccessibleAcls', () => {
  it('throws AclClientError(IndexerRequired) when indexerUrl is not configured', async () => {
    const client = makeClient() // no indexerUrl
    await expect(client.getAccessibleAcls(OWNER)).rejects.toMatchObject({
      code: AclError.IndexerRequired,
    })
  })

  it('delegates to fetchAccessibleAcls when indexerUrl is configured', async () => {
    mockFetchAccessibleAcls.mockResolvedValue(['0xacl1', '0xacl2'])
    const client = makeClient({ indexerUrl: INDEXER })

    const result = await client.getAccessibleAcls(OWNER)

    expect(result).toEqual(['0xacl1', '0xacl2'])
    expect(mockFetchAccessibleAcls).toHaveBeenCalledWith(INDEXER, OWNER)
  })
})

// ── hasAccess ─────────────────────────────────────────────────────────────────

describe('hasAccess', () => {
  it('returns true for the owner', async () => {
    mockFetchAllowListDetail.mockResolvedValue(makeAclDetail({ owner: OWNER }))
    const client = makeClient()
    expect(await client.hasAccess({ aclId: ACL_ID, address: OWNER })).toBe(true)
  })

  it('returns true for a member in the role list', async () => {
    mockFetchAllowListDetail.mockResolvedValue(
      makeAclDetail({ roles: [{ type: 'address', address: MEMBER }] }),
    )
    const client = makeClient()
    expect(await client.hasAccess({ aclId: ACL_ID, address: MEMBER })).toBe(
      true,
    )
  })

  it('returns false for an address that has no role', async () => {
    mockFetchAllowListDetail.mockResolvedValue(makeAclDetail())
    const client = makeClient()
    expect(
      await client.hasAccess({ aclId: ACL_ID, address: '0xstranger' }),
    ).toBe(false)
  })
})

// ── resolveRoles ──────────────────────────────────────────────────────────────

describe('resolveRoles', () => {
  it('returns roles matching the address', async () => {
    mockFetchAllowListDetail.mockResolvedValue(
      makeAclDetail({
        roles: [
          { type: 'address', address: MEMBER },
          { type: 'address', address: '0xother' },
        ],
      }),
    )
    const client = makeClient()
    const roles = await client.resolveRoles({ aclId: ACL_ID, address: MEMBER })
    expect(roles).toHaveLength(1)
    expect(roles[0]).toEqual({ type: 'address', address: MEMBER })
  })

  it('returns an empty array when the address has no roles', async () => {
    mockFetchAllowListDetail.mockResolvedValue(makeAclDetail())
    const client = makeClient()
    const roles = await client.resolveRoles({ aclId: ACL_ID, address: MEMBER })
    expect(roles).toEqual([])
  })
})

// ── addRole / removeRole ──────────────────────────────────────────────────────

describe('addRole', () => {
  it('executes a transaction and returns the new epoch', async () => {
    const executor = makeExecutor()
    mockFetchAllowListMeta.mockResolvedValue(makeAclMeta({ epoch: 4 }))
    const client = makeClient({ executor })

    const result = await client.addRole({
      aclId: ACL_ID,
      adminCapId: CAP_ID,
      role: { type: 'address', address: MEMBER },
    })

    expect(executor).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ epoch: 4 })
  })
})

describe('removeRole', () => {
  it('executes a transaction and returns the new epoch', async () => {
    const executor = makeExecutor()
    mockFetchAllowListMeta.mockResolvedValue(makeAclMeta({ epoch: 5 }))
    const client = makeClient({ executor })

    const result = await client.removeRole({
      aclId: ACL_ID,
      adminCapId: CAP_ID,
      role: { type: 'address', address: MEMBER },
    })

    expect(executor).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ epoch: 5 })
  })
})

// ── createAcl ─────────────────────────────────────────────────────────────────

describe('createAcl', () => {
  it('throws UnexpectedResponse when objectChanges lacks AllowList or AdminCap', async () => {
    const executor = (jest.fn() as any).mockResolvedValue({
      digest: '0xd',
      objectChanges: [],
    })
    const client = makeClient({ executor })

    await expect(client.createAcl({ name: 'My ACL' })).rejects.toMatchObject({
      code: AclError.UnexpectedResponse,
    })
  })

  it('creates an ACL and returns aclId, adminCapId, and epoch', async () => {
    const executor = (jest.fn() as any).mockResolvedValue({
      digest: '0xd',
      objectChanges: [
        {
          type: 'created',
          objectId: ACL_ID,
          objectType: '0xpkg::acl_encrypt::AllowList',
        },
        {
          type: 'created',
          objectId: CAP_ID,
          objectType: '0xpkg::acl_encrypt::AdminCap',
        },
      ],
    })
    mockFetchAllowListDetail.mockResolvedValue(makeAclDetail({ epoch: 0 }))
    const client = makeClient({ executor })

    const result = await client.createAcl({ name: 'My ACL' })

    expect(result.aclId).toBe(ACL_ID)
    expect(result.adminCapId).toBe(CAP_ID)
    expect(result.epoch).toBe(0)
  })

  it('adds initial roles after creating the ACL', async () => {
    const executor = (jest.fn() as any)
      .mockResolvedValueOnce({
        digest: '0xd',
        objectChanges: [
          {
            type: 'created',
            objectId: ACL_ID,
            objectType: '0xpkg::acl_encrypt::AllowList',
          },
          {
            type: 'created',
            objectId: CAP_ID,
            objectType: '0xpkg::acl_encrypt::AdminCap',
          },
        ],
      })
      .mockResolvedValue({ digest: '0xd2', objectChanges: [] }) // for addRole tx

    mockFetchAllowListMeta.mockResolvedValue(makeAclMeta({ epoch: 0 }))
    const client = makeClient({ executor })

    await client.createAcl({
      name: 'My ACL',
      initialRoles: [{ type: 'address', address: MEMBER }],
    })

    // Called once for createAcl, once for addRole
    expect(executor).toHaveBeenCalledTimes(2)
  })
})

// ── writeData ─────────────────────────────────────────────────────────────────

describe('writeData', () => {
  const signPersonalMessage = (jest.fn() as any).mockResolvedValue('sig')

  it('encrypts, uploads, and publishes an entry', async () => {
    const executor = (jest.fn() as any).mockResolvedValue({
      digest: '0xd',
      objectChanges: [
        {
          type: 'created',
          objectId: ENTRY_ID,
          objectType: '0xpkg::acl_encrypt::EncryptedEntry',
        },
      ],
    })
    const storageAdapter = makeStorageAdapter()
    mockFetchAllowListMeta.mockResolvedValue(makeAclMeta({ epoch: 2 }))
    mockSealEncrypt.mockResolvedValue(ENCRYPTED)

    const client = makeClient({ executor, storageAdapter })
    const result = await client.writeData({
      aclId: ACL_ID,
      plaintext: PLAINTEXT,
      description: 'my data',
      walletAddress: OWNER,
      signPersonalMessage,
    })

    expect(mockSealEncrypt).toHaveBeenCalledWith(
      expect.anything(),
      PKG,
      ACL_ID,
      PLAINTEXT,
    )
    expect(storageAdapter.upload).toHaveBeenCalledWith(ENCRYPTED)
    expect(executor).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      entryId: ENTRY_ID,
      location: `ipfs://${CID}`,
      epoch: 2,
    })
  })

  it('accepts plaintext as a string', async () => {
    const executor = (jest.fn() as any).mockResolvedValue({
      digest: '0xd',
      objectChanges: [
        {
          type: 'created',
          objectId: ENTRY_ID,
          objectType: '0xpkg::acl_encrypt::EncryptedEntry',
        },
      ],
    })
    mockFetchAllowListMeta.mockResolvedValue(makeAclMeta())
    mockSealEncrypt.mockResolvedValue(ENCRYPTED)

    const client = makeClient({ executor })
    await client.writeData({
      aclId: ACL_ID,
      plaintext: 'hello world',
      description: 'text',
      walletAddress: OWNER,
      signPersonalMessage,
    })

    const encryptCall = mockSealEncrypt.mock.calls[0][3]
    expect(encryptCall).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(encryptCall)).toBe('hello world')
  })

  it('throws UnexpectedResponse when EncryptedEntry is missing from objectChanges', async () => {
    const executor = (jest.fn() as any).mockResolvedValue({
      digest: '0xd',
      objectChanges: [],
    })
    mockFetchAllowListMeta.mockResolvedValue(makeAclMeta())
    mockSealEncrypt.mockResolvedValue(ENCRYPTED)

    const client = makeClient({ executor })
    await expect(
      client.writeData({
        aclId: ACL_ID,
        plaintext: PLAINTEXT,
        description: 'x',
        walletAddress: OWNER,
        signPersonalMessage,
      }),
    ).rejects.toMatchObject({ code: AclError.UnexpectedResponse })
  })
})

// ── readData ──────────────────────────────────────────────────────────────────

describe('readData', () => {
  const signPersonalMessage = (jest.fn() as any).mockResolvedValue('sig')

  it('downloads and decrypts an entry', async () => {
    const storageAdapter = makeStorageAdapter()
    mockFetchAllowListMeta.mockResolvedValue(makeAclMeta({ epoch: 1 }))
    mockFetchEncryptedEntry.mockResolvedValue(makeEntry())
    mockSealDecrypt.mockResolvedValue(PLAINTEXT)

    const client = makeClient({ storageAdapter })
    const result = await client.readData({
      aclId: ACL_ID,
      entryId: ENTRY_ID,
      walletAddress: OWNER,
      signPersonalMessage,
    })

    expect(storageAdapter.download).toHaveBeenCalledWith(`ipfs://${CID}`)
    expect(mockSealDecrypt).toHaveBeenCalledWith(
      expect.objectContaining({
        packageId: PKG,
        allowlistId: ACL_ID,
        encryptedData: ENCRYPTED,
        walletAddress: OWNER,
      }),
    )
    expect(result).toBe(PLAINTEXT)
  })

  it('throws AclClientError(EntryNotFound) when entry does not exist', async () => {
    mockFetchAllowListMeta.mockResolvedValue(makeAclMeta())
    mockFetchEncryptedEntry.mockResolvedValue(null)

    const client = makeClient()
    await expect(
      client.readData({
        aclId: ACL_ID,
        entryId: ENTRY_ID,
        walletAddress: OWNER,
        signPersonalMessage,
      }),
    ).rejects.toMatchObject({ code: AclError.EntryNotFound })
  })
})

// ── editData ──────────────────────────────────────────────────────────────────

describe('editData', () => {
  const signPersonalMessage = (jest.fn() as any).mockResolvedValue('sig')

  it('re-encrypts, uploads, and edits the entry', async () => {
    const executor = makeExecutor()
    const storageAdapter = makeStorageAdapter()
    mockFetchAllowListMeta.mockResolvedValue(makeAclMeta({ epoch: 3 }))
    mockSealEncrypt.mockResolvedValue(ENCRYPTED)

    const client = makeClient({ executor, storageAdapter })
    const result = await client.editData({
      aclId: ACL_ID,
      entryId: ENTRY_ID,
      newPlaintext: PLAINTEXT,
      walletAddress: OWNER,
      signPersonalMessage,
    })

    expect(mockSealEncrypt).toHaveBeenCalledWith(
      expect.anything(),
      PKG,
      ACL_ID,
      PLAINTEXT,
    )
    expect(storageAdapter.upload).toHaveBeenCalledWith(ENCRYPTED)
    expect(executor).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      entryId: ENTRY_ID,
      location: `ipfs://${CID}`,
      epoch: 3,
    })
  })
})

// ── getStaleEntries ───────────────────────────────────────────────────────────

describe('getStaleEntries', () => {
  it('returns only entries where isStale is true', async () => {
    const staleEntry = makeEntry({ id: '0xstale', isStale: true })
    const freshEntry = makeEntry({ id: '0xfresh', isStale: false })
    mockFetchAllowListDetail.mockResolvedValue(
      makeAclDetail({ entries: [staleEntry, freshEntry] }),
    )

    const client = makeClient()
    const result = await client.getStaleEntries(ACL_ID)

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('0xstale')
  })

  it('returns an empty array when all entries are fresh', async () => {
    mockFetchAllowListDetail.mockResolvedValue(
      makeAclDetail({ entries: [makeEntry({ isStale: false })] }),
    )

    const client = makeClient()
    expect(await client.getStaleEntries(ACL_ID)).toEqual([])
  })
})

// ── isEntryStale ──────────────────────────────────────────────────────────────

describe('isEntryStale', () => {
  it('returns true for a stale entry', async () => {
    mockFetchAllowListMeta.mockResolvedValue(makeAclMeta({ epoch: 5 }))
    mockFetchEncryptedEntry.mockResolvedValue(makeEntry({ isStale: true }))

    const client = makeClient()
    expect(
      await client.isEntryStale({ aclId: ACL_ID, entryId: ENTRY_ID }),
    ).toBe(true)
  })

  it('returns false for a fresh entry', async () => {
    mockFetchAllowListMeta.mockResolvedValue(makeAclMeta({ epoch: 5 }))
    mockFetchEncryptedEntry.mockResolvedValue(makeEntry({ isStale: false }))

    const client = makeClient()
    expect(
      await client.isEntryStale({ aclId: ACL_ID, entryId: ENTRY_ID }),
    ).toBe(false)
  })

  it('throws AclClientError(EntryNotFound) when entry does not exist', async () => {
    mockFetchAllowListMeta.mockResolvedValue(makeAclMeta())
    mockFetchEncryptedEntry.mockResolvedValue(null)

    const client = makeClient()
    await expect(
      client.isEntryStale({ aclId: ACL_ID, entryId: ENTRY_ID }),
    ).rejects.toMatchObject({
      code: AclError.EntryNotFound,
    })
  })
})

// ── rotateEntry ───────────────────────────────────────────────────────────────

describe('rotateEntry', () => {
  const signPersonalMessage = (jest.fn() as any).mockResolvedValue('sig')

  it('throws AclClientError(EntryNotFound) when entry does not exist', async () => {
    mockFetchAllowListMeta.mockResolvedValue(makeAclMeta())
    mockFetchEncryptedEntry.mockResolvedValue(null)

    const client = makeClient()
    await expect(
      client.rotateEntry({
        aclId: ACL_ID,
        entryId: ENTRY_ID,
        walletAddress: OWNER,
        signPersonalMessage,
      }),
    ).rejects.toMatchObject({ code: AclError.EntryNotFound })
  })

  it('throws AclClientError(AlreadyCurrentEpoch) when entry is not stale', async () => {
    mockFetchAllowListMeta.mockResolvedValue(makeAclMeta({ epoch: 2 }))
    mockFetchEncryptedEntry.mockResolvedValue(makeEntry({ isStale: false }))

    const client = makeClient()
    await expect(
      client.rotateEntry({
        aclId: ACL_ID,
        entryId: ENTRY_ID,
        walletAddress: OWNER,
        signPersonalMessage,
      }),
    ).rejects.toMatchObject({ code: AclError.AlreadyCurrentEpoch })
  })

  it('decrypts, re-encrypts, and updates a stale entry', async () => {
    const executor = makeExecutor()
    const storageAdapter = makeStorageAdapter()
    const newCid = 'QmNewCid'

    mockFetchAllowListMeta.mockResolvedValue(makeAclMeta({ epoch: 3 }))
    mockFetchEncryptedEntry
      .mockResolvedValueOnce(makeEntry({ isStale: true })) // first call in rotateEntry
      .mockResolvedValueOnce(makeEntry({ isStale: true })) // second call inside readData
    mockSealDecrypt.mockResolvedValue(PLAINTEXT)
    mockSealEncrypt.mockResolvedValue(ENCRYPTED)
    storageAdapter.upload.mockResolvedValue(`ipfs://${newCid}`)

    const client = makeClient({ executor, storageAdapter })
    const result = await client.rotateEntry({
      aclId: ACL_ID,
      entryId: ENTRY_ID,
      walletAddress: OWNER,
      signPersonalMessage,
    })

    expect(mockSealDecrypt).toHaveBeenCalled()
    expect(mockSealEncrypt).toHaveBeenCalled()
    expect(executor).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ newLocation: `ipfs://${newCid}`, epoch: 3 })
  })
})

// ── rotateAllStaleEntries ─────────────────────────────────────────────────────

describe('rotateAllStaleEntries', () => {
  const signPersonalMessage = (jest.fn() as any).mockResolvedValue('sig')

  it('returns rotated=0 and skipped=0 when there are no stale entries', async () => {
    mockFetchAllowListDetail.mockResolvedValue(makeAclDetail({ entries: [] }))

    const client = makeClient()
    const result = await client.rotateAllStaleEntries({
      aclId: ACL_ID,
      walletAddress: OWNER,
      signPersonalMessage,
    })

    expect(result).toEqual({ rotated: 0, skipped: 0 })
  })

  it('calls onProgress with running totals', async () => {
    const stale1 = makeEntry({ id: '0xe1', isStale: true })
    const stale2 = makeEntry({ id: '0xe2', isStale: true })
    mockFetchAllowListDetail.mockResolvedValue(
      makeAclDetail({ entries: [stale1, stale2] }),
    )
    mockFetchAllowListMeta.mockResolvedValue(makeAclMeta({ epoch: 2 }))
    mockFetchEncryptedEntry.mockResolvedValue(makeEntry({ isStale: true }))
    mockSealDecrypt.mockResolvedValue(PLAINTEXT)
    mockSealEncrypt.mockResolvedValue(ENCRYPTED)

    const onProgress = jest.fn()
    const client = makeClient()
    await client.rotateAllStaleEntries({
      aclId: ACL_ID,
      walletAddress: OWNER,
      signPersonalMessage,
      onProgress,
    })

    expect(onProgress).toHaveBeenCalledTimes(2)
    expect(onProgress).toHaveBeenNthCalledWith(1, 1, 2)
    expect(onProgress).toHaveBeenNthCalledWith(2, 2, 2)
  })
})

// ── transferAdminCap ──────────────────────────────────────────────────────────

describe('transferAdminCap', () => {
  it('executes a transfer transaction', async () => {
    const executor = makeExecutor()
    const client = makeClient({ executor })

    await client.transferAdminCap({ adminCapId: CAP_ID, newOwner: MEMBER })

    expect(executor).toHaveBeenCalledTimes(1)
  })
})
