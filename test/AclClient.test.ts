import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import type {
  AclClientConfig,
  AclDetail,
  AclMeta,
  EntryMeta,
} from '../src/types'
import { AclError } from '../src/errors'

// ── Mock functions (defined before unstable_mockModule calls) ─────────────────

const mockFetchKeyspaceMeta = jest.fn() as any
const mockFetchKeyspaceDetail = jest.fn() as any
const mockFetchEncryptedEntry = jest.fn() as any
const mockFetchAccessibleKeyspaces = jest.fn() as any
const mockSealEncrypt = jest.fn() as any
const mockSealDecrypt = jest.fn() as any

// ── Module mocks (must precede dynamic imports) ────────────────────────────────

jest.unstable_mockModule('../src/queries', () => ({
  fetchKeyspaceMeta: mockFetchKeyspaceMeta,
  fetchKeyspaceDetail: mockFetchKeyspaceDetail,
  fetchEncryptedEntry: mockFetchEncryptedEntry,
  fetchAccessibleKeyspaces: mockFetchAccessibleKeyspaces,
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
const DAO_ID =
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
    name: 'Test ACL',
    epoch: 1,
    entryCount: 0,
    ...overrides,
  }
}

function makeAclDetail(overrides: Partial<AclDetail> = {}): AclDetail {
  return {
    ...makeAclMeta(),
    grantPrincipals: [],
    readPrincipals: [],
    writePrincipals: [],
    roles: [],
    entries: [],
    ...overrides,
  }
}

function makeEntry(overrides: Partial<EntryMeta> = {}): EntryMeta {
  return {
    id: ENTRY_ID,
    keyspaceId: ACL_ID,
    uri: `ipfs://${CID}`,
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
    daoId: DAO_ID,
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
    mockFetchKeyspaceDetail.mockResolvedValue(detail)

    const client = makeClient()
    const result = await client.getAcl(ACL_ID)

    expect(result).toBe(detail)
    expect(mockFetchKeyspaceDetail).toHaveBeenCalledWith(
      expect.anything(),
      ACL_ID,
    )
  })

  it('throws AclClientError(EntryNotFound) when ACL does not exist', async () => {
    mockFetchKeyspaceDetail.mockResolvedValue(null)

    const client = makeClient()
    await expect(client.getAcl(ACL_ID)).rejects.toMatchObject({
      code: AclError.EntryNotFound,
    })
  })
})

// ── getAccessibleAcls ─────────────────────────────────────────────────────────

describe('getAccessibleAcls', () => {
  it('throws AclClientError(IndexerRequired) when indexerUrl is not configured', async () => {
    const client = makeClient({ indexerUrl: undefined })
    await expect(client.getAccessibleAcls(OWNER)).rejects.toMatchObject({
      code: AclError.IndexerRequired,
    })
  })

  it('delegates to fetchAccessibleKeyspaces when indexerUrl is configured', async () => {
    mockFetchAccessibleKeyspaces.mockResolvedValue(['0xacl1', '0xacl2'])
    const client = makeClient({ indexerUrl: INDEXER })

    const result = await client.getAccessibleAcls(OWNER)

    expect(result).toEqual(['0xacl1', '0xacl2'])
    expect(mockFetchAccessibleKeyspaces).toHaveBeenCalledWith(INDEXER, OWNER)
  })
})

// ── hasAccess ─────────────────────────────────────────────────────────────────

describe('hasAccess', () => {
  it('returns true for a player in readPrincipals', async () => {
    mockFetchKeyspaceDetail.mockResolvedValue(
      makeAclDetail({
        readPrincipals: [{ type: 'player', address: MEMBER }],
        roles: [{ type: 'player', address: MEMBER }],
      }),
    )
    const client = makeClient()
    expect(await client.hasAccess({ aclId: ACL_ID, address: MEMBER })).toBe(
      true,
    )
  })

  it('returns true for an OU principal when matching daoId is provided', async () => {
    mockFetchKeyspaceDetail.mockResolvedValue(
      makeAclDetail({
        readPrincipals: [{ type: 'ou', daoId: DAO_ID }],
        roles: [],
      }),
    )
    const client = makeClient()
    expect(
      await client.hasAccess({ aclId: ACL_ID, address: MEMBER, daoId: DAO_ID }),
    ).toBe(true)
  })

  it('returns false for an OU principal when daoId is not provided', async () => {
    mockFetchKeyspaceDetail.mockResolvedValue(
      makeAclDetail({
        readPrincipals: [{ type: 'ou', daoId: DAO_ID }],
        roles: [],
      }),
    )
    const client = makeClient()
    expect(await client.hasAccess({ aclId: ACL_ID, address: MEMBER })).toBe(
      false,
    )
  })

  it('returns false for an address not in readPrincipals', async () => {
    mockFetchKeyspaceDetail.mockResolvedValue(makeAclDetail())
    const client = makeClient()
    expect(
      await client.hasAccess({ aclId: ACL_ID, address: '0xstranger' }),
    ).toBe(false)
  })
})

// ── grant / revoke ────────────────────────────────────────────────────────────

describe('grant', () => {
  it('executes a transaction and returns the new epoch', async () => {
    const executor = makeExecutor()
    mockFetchKeyspaceMeta.mockResolvedValue(makeAclMeta({ epoch: 4 }))
    const client = makeClient({ executor })

    const result = await client.grant({
      aclId: ACL_ID,
      keyspaceRole: 'Read',
      principal: { type: 'player', address: MEMBER },
    })

    expect(executor).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ epoch: 4 })
  })

  it('throws DaoIdRequired when no daoId is configured', async () => {
    const client = makeClient({ daoId: undefined })
    await expect(
      client.grant({
        aclId: ACL_ID,
        keyspaceRole: 'Read',
        principal: { type: 'player', address: MEMBER },
      }),
    ).rejects.toMatchObject({ code: AclError.DaoIdRequired })
  })

  it('uses per-method daoId override', async () => {
    const executor = makeExecutor()
    mockFetchKeyspaceMeta.mockResolvedValue(makeAclMeta({ epoch: 2 }))
    const OVERRIDE_DAO =
      '0x0000000000000000000000000000000000000000000000000000000000009999'
    const client = makeClient({ executor, daoId: undefined })

    const result = await client.grant({
      aclId: ACL_ID,
      keyspaceRole: 'Write',
      principal: { type: 'player', address: MEMBER },
      daoId: OVERRIDE_DAO,
    })

    expect(executor).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ epoch: 2 })
  })
})

describe('revoke', () => {
  it('executes a transaction and returns the new epoch', async () => {
    const executor = makeExecutor()
    mockFetchKeyspaceMeta.mockResolvedValue(makeAclMeta({ epoch: 5 }))
    const client = makeClient({ executor })

    const result = await client.revoke({
      aclId: ACL_ID,
      keyspaceRole: 'Read',
      principal: { type: 'player', address: MEMBER },
    })

    expect(executor).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ epoch: 5 })
  })
})

// ── createAcl ─────────────────────────────────────────────────────────────────

describe('createAcl', () => {
  it('throws UnexpectedResponse when objectChanges lacks a Keyspace', async () => {
    const executor = (jest.fn() as any).mockResolvedValue({
      digest: '0xd',
      objectChanges: [],
    })
    const client = makeClient({ executor })

    await expect(client.createAcl({ name: 'My ACL' })).rejects.toMatchObject({
      code: AclError.UnexpectedResponse,
    })
  })

  it('creates an ACL and returns aclId and epoch', async () => {
    const executor = (jest.fn() as any).mockResolvedValue({
      digest: '0xd',
      objectChanges: [
        {
          type: 'created',
          objectId: ACL_ID,
          objectType: `${PKG}::keyspace::Keyspace`,
        },
      ],
    })
    mockFetchKeyspaceMeta.mockResolvedValue(makeAclMeta({ epoch: 0 }))
    const client = makeClient({ executor })

    const result = await client.createAcl({ name: 'My ACL' })

    expect(result.aclId).toBe(ACL_ID)
    expect(result.epoch).toBe(0)
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
          objectType: `${PKG}::keyspace::EncryptedEntry`,
        },
      ],
    })
    const storageAdapter = makeStorageAdapter()
    mockFetchKeyspaceMeta.mockResolvedValue(makeAclMeta({ epoch: 2 }))
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
      uri: `ipfs://${CID}`,
      epoch: 2,
    })
  })

  it('accepts string plaintext and converts to Uint8Array', async () => {
    const executor = (jest.fn() as any).mockResolvedValue({
      digest: '0xd',
      objectChanges: [
        {
          type: 'created',
          objectId: ENTRY_ID,
          objectType: `${PKG}::keyspace::EncryptedEntry`,
        },
      ],
    })
    mockFetchKeyspaceMeta.mockResolvedValue(makeAclMeta())
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
    mockFetchKeyspaceMeta.mockResolvedValue(makeAclMeta())
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
    mockFetchKeyspaceMeta.mockResolvedValue(makeAclMeta({ epoch: 1 }))
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
        keyspaceId: ACL_ID,
        encryptedData: ENCRYPTED,
        walletAddress: OWNER,
      }),
    )
    expect(result).toBe(PLAINTEXT)
  })

  it('throws AclClientError(EntryNotFound) when entry does not exist', async () => {
    mockFetchKeyspaceMeta.mockResolvedValue(makeAclMeta())
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
    mockFetchKeyspaceMeta.mockResolvedValue(makeAclMeta({ epoch: 3 }))
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
      uri: `ipfs://${CID}`,
      epoch: 3,
    })
  })
})

// ── getStaleEntries ───────────────────────────────────────────────────────────

describe('getStaleEntries', () => {
  it('returns only entries where isStale is true', async () => {
    const staleEntry = makeEntry({ id: '0xstale', isStale: true })
    const freshEntry = makeEntry({ id: '0xfresh', isStale: false })
    mockFetchKeyspaceDetail.mockResolvedValue(
      makeAclDetail({ entries: [staleEntry, freshEntry] }),
    )

    const client = makeClient()
    const result = await client.getStaleEntries(ACL_ID)

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('0xstale')
  })

  it('returns an empty array when all entries are fresh', async () => {
    mockFetchKeyspaceDetail.mockResolvedValue(
      makeAclDetail({ entries: [makeEntry({ isStale: false })] }),
    )

    const client = makeClient()
    expect(await client.getStaleEntries(ACL_ID)).toEqual([])
  })
})

// ── isEntryStale ──────────────────────────────────────────────────────────────

describe('isEntryStale', () => {
  it('returns true for a stale entry', async () => {
    mockFetchKeyspaceMeta.mockResolvedValue(makeAclMeta({ epoch: 5 }))
    mockFetchEncryptedEntry.mockResolvedValue(makeEntry({ isStale: true }))

    const client = makeClient()
    expect(
      await client.isEntryStale({ aclId: ACL_ID, entryId: ENTRY_ID }),
    ).toBe(true)
  })

  it('returns false for a fresh entry', async () => {
    mockFetchKeyspaceMeta.mockResolvedValue(makeAclMeta({ epoch: 5 }))
    mockFetchEncryptedEntry.mockResolvedValue(makeEntry({ isStale: false }))

    const client = makeClient()
    expect(
      await client.isEntryStale({ aclId: ACL_ID, entryId: ENTRY_ID }),
    ).toBe(false)
  })

  it('throws AclClientError(EntryNotFound) when entry does not exist', async () => {
    mockFetchKeyspaceMeta.mockResolvedValue(makeAclMeta())
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
    mockFetchKeyspaceMeta.mockResolvedValue(makeAclMeta())
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
    mockFetchKeyspaceMeta.mockResolvedValue(makeAclMeta({ epoch: 2 }))
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

    mockFetchKeyspaceMeta.mockResolvedValue(makeAclMeta({ epoch: 3 }))
    mockFetchEncryptedEntry
      .mockResolvedValueOnce(makeEntry({ isStale: true }))
      .mockResolvedValueOnce(makeEntry({ isStale: true }))
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
    expect(result).toEqual({ newUri: `ipfs://${newCid}`, epoch: 3 })
  })
})

// ── rotateAllStaleEntries ─────────────────────────────────────────────────────

describe('rotateAllStaleEntries', () => {
  const signPersonalMessage = (jest.fn() as any).mockResolvedValue('sig')

  it('returns rotated=0 and skipped=0 when there are no stale entries', async () => {
    mockFetchKeyspaceDetail.mockResolvedValue(makeAclDetail({ entries: [] }))

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
    mockFetchKeyspaceDetail.mockResolvedValue(
      makeAclDetail({ entries: [stale1, stale2] }),
    )
    mockFetchKeyspaceMeta.mockResolvedValue(makeAclMeta({ epoch: 2 }))
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
