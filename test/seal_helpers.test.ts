import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from '@jest/globals'

// ── Mock @mysten/seal ──────────────────────────────────────────────────────────

const mockGetPersonalMessage = jest
  .fn<() => Uint8Array>()
  .mockReturnValue(new Uint8Array([1, 2, 3]))
const mockSetPersonalMessageSignature = jest
  .fn<() => Promise<void>>()
  .mockResolvedValue(undefined)

const mockSessionKeyInstance = {
  getPersonalMessage: mockGetPersonalMessage,
  setPersonalMessageSignature: mockSetPersonalMessageSignature,
}

const mockSessionKeyCreate = jest
  .fn<() => Promise<typeof mockSessionKeyInstance>>()
  .mockResolvedValue(mockSessionKeyInstance)

const mockEncryptedObjectParse = jest.fn()

jest.unstable_mockModule('@mysten/seal', () => ({
  SessionKey: { create: mockSessionKeyCreate },
  EncryptedObject: { parse: mockEncryptedObjectParse },
}))

// ── Mock @mysten/sui/transactions ─────────────────────────────────────────────

const mockMoveCall = jest.fn()
const mockPureVector = jest.fn().mockReturnValue('pureVectorArg')
const mockTxObject = jest.fn().mockReturnValue('objectArg')
const mockBuild = (jest.fn() as any).mockResolvedValue(
  new Uint8Array([9, 9, 9]),
)

jest.unstable_mockModule('@mysten/sui/transactions', () => ({
  Transaction: jest.fn().mockImplementation(() => ({
    moveCall: mockMoveCall,
    pure: { vector: mockPureVector },
    object: mockTxObject,
    build: mockBuild,
  })),
}))

// ── Dynamic imports (after mock registration) ─────────────────────────────────

const { sealEncrypt, sealDecrypt, clearSessionCache } =
  await import('../src/seal_helpers')

// ── Constants ─────────────────────────────────────────────────────────────────

// Valid 32-byte Sui object IDs (0x + 64 hex chars)
const PKG = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
const KEYSPACE_ID =
  '0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20'
const DAO_ID =
  '0xaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd'
const WALLET =
  '0x1111111111111111111111111111111111111111111111111111111111111111'

const PLAINTEXT = new Uint8Array([10, 20, 30])
const ENCRYPTED = new Uint8Array([99, 88, 77])

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSealClient(overrides: Record<string, any> = {}) {
  return {
    encrypt: (jest.fn() as any).mockResolvedValue({
      encryptedObject: ENCRYPTED,
    }),
    decrypt: (jest.fn() as any).mockResolvedValue(PLAINTEXT),
    ...overrides,
  }
}

function makeDecryptOpts(overrides: Record<string, any> = {}) {
  return {
    packageId: PKG,
    keyspaceId: KEYSPACE_ID,
    daoId: DAO_ID,
    encryptedData: ENCRYPTED,
    walletAddress: WALLET,
    signPersonalMessage: (jest.fn() as any).mockResolvedValue('sig'),
    suiClient: {},
    sealClient: makeSealClient(),
    ...overrides,
  }
}

// ── sealEncrypt ───────────────────────────────────────────────────────────────

describe('sealEncrypt', () => {
  it('passes threshold: 1 to sealClient.encrypt', async () => {
    const sealClient = makeSealClient()
    await sealEncrypt(sealClient, PKG, KEYSPACE_ID, PLAINTEXT)
    expect(sealClient.encrypt).toHaveBeenCalledWith(
      expect.objectContaining({ threshold: 1 }),
    )
  })

  it('builds a 37-byte policy ID (32 keyspace + 5 nonce), hex-encoded as 74 chars', async () => {
    const sealClient = makeSealClient()
    await sealEncrypt(sealClient, PKG, KEYSPACE_ID, PLAINTEXT)
    const { id } = (sealClient.encrypt as jest.MockedFunction<any>).mock
      .calls[0][0]
    expect(typeof id).toBe('string')
    expect(id.length).toBe(74)
  })

  it('policy ID prefix matches the keyspace bytes', async () => {
    const sealClient = makeSealClient()
    await sealEncrypt(sealClient, PKG, KEYSPACE_ID, PLAINTEXT)
    const { id } = (sealClient.encrypt as jest.MockedFunction<any>).mock
      .calls[0][0]
    // toHex output is lowercase hex without 0x prefix; KEYSPACE_ID has 0x prefix
    const keyspaceHex = KEYSPACE_ID.slice(2).toLowerCase()
    expect(id.startsWith(keyspaceHex)).toBe(true)
  })

  it('passes packageId and data through unchanged', async () => {
    const sealClient = makeSealClient()
    await sealEncrypt(sealClient, PKG, KEYSPACE_ID, PLAINTEXT)
    expect(sealClient.encrypt).toHaveBeenCalledWith(
      expect.objectContaining({ packageId: PKG, data: PLAINTEXT }),
    )
  })

  it('returns the encryptedObject from sealClient.encrypt', async () => {
    const sealClient = makeSealClient()
    const result = await sealEncrypt(sealClient, PKG, KEYSPACE_ID, PLAINTEXT)
    expect(result).toBe(ENCRYPTED)
  })

  it('generates a unique nonce on each call (last 10 hex chars differ)', async () => {
    const sealClient = makeSealClient()
    await sealEncrypt(sealClient, PKG, KEYSPACE_ID, PLAINTEXT)
    await sealEncrypt(sealClient, PKG, KEYSPACE_ID, PLAINTEXT)
    const calls = (sealClient.encrypt as jest.MockedFunction<any>).mock.calls
    const id1: string = calls[0][0].id
    const id2: string = calls[1][0].id
    // Prefix (keyspace bytes) must match; nonce suffix must differ
    expect(id1.slice(0, 64)).toBe(id2.slice(0, 64))
    expect(id1.slice(64)).not.toBe(id2.slice(64))
  })
})

// ── sealDecrypt ───────────────────────────────────────────────────────────────

describe('sealDecrypt', () => {
  beforeEach(() => {
    clearSessionCache()
    jest.clearAllMocks()
    mockSessionKeyCreate.mockResolvedValue(mockSessionKeyInstance)
    mockGetPersonalMessage.mockReturnValue(new Uint8Array([1, 2, 3]))
    mockSetPersonalMessageSignature.mockResolvedValue(undefined)
    mockEncryptedObjectParse.mockReturnValue({ id: KEYSPACE_ID })
    mockBuild.mockResolvedValue(new Uint8Array([9, 9, 9]))
  })

  it('creates a session key via SessionKey.create on first call', async () => {
    await sealDecrypt(makeDecryptOpts())
    expect(mockSessionKeyCreate).toHaveBeenCalledTimes(1)
    expect(mockSessionKeyCreate).toHaveBeenCalledWith(
      expect.objectContaining({ address: WALLET, packageId: PKG }),
    )
  })

  it('uses SESSION_TTL_MIN (10) as default sessionKeyTtlMin', async () => {
    await sealDecrypt(makeDecryptOpts())
    expect(mockSessionKeyCreate).toHaveBeenCalledWith(
      expect.objectContaining({ ttlMin: 10 }),
    )
  })

  it('respects a custom sessionKeyTtlMin', async () => {
    await sealDecrypt(makeDecryptOpts({ sessionKeyTtlMin: 30 }))
    expect(mockSessionKeyCreate).toHaveBeenCalledWith(
      expect.objectContaining({ ttlMin: 30 }),
    )
  })

  it('caches the session key — second call with same address skips creation', async () => {
    await sealDecrypt(makeDecryptOpts())
    await sealDecrypt(makeDecryptOpts())
    expect(mockSessionKeyCreate).toHaveBeenCalledTimes(1)
  })

  it('recreates session key after clearSessionCache', async () => {
    await sealDecrypt(makeDecryptOpts())
    clearSessionCache()
    await sealDecrypt(makeDecryptOpts())
    expect(mockSessionKeyCreate).toHaveBeenCalledTimes(2)
  })

  it('passes the personal-message signature to setPersonalMessageSignature', async () => {
    const signPersonalMessage = (jest.fn() as any).mockResolvedValue('test-sig')
    await sealDecrypt(makeDecryptOpts({ signPersonalMessage }))
    expect(mockSetPersonalMessageSignature).toHaveBeenCalledWith('test-sig')
  })

  it('calls sealClient.decrypt with encryptedData and the session key', async () => {
    const sealClient = makeSealClient()
    await sealDecrypt(makeDecryptOpts({ sealClient }))
    expect(sealClient.decrypt).toHaveBeenCalledWith(
      expect.objectContaining({
        data: ENCRYPTED,
        sessionKey: mockSessionKeyInstance,
      }),
    )
  })

  it('returns the plaintext from sealClient.decrypt', async () => {
    const sealClient = makeSealClient()
    sealClient.decrypt.mockResolvedValue(PLAINTEXT)
    const result = await sealDecrypt(makeDecryptOpts({ sealClient }))
    expect(result).toBe(PLAINTEXT)
  })

  it('builds the seal_approve PTB with the correct move-call target', async () => {
    await sealDecrypt(makeDecryptOpts())
    expect(mockMoveCall).toHaveBeenCalledWith(
      expect.objectContaining({
        target: `${PKG}::keyspace::seal_approve`,
      }),
    )
  })

  it('builds the PTB with onlyTransactionKind: true', async () => {
    await sealDecrypt(makeDecryptOpts())
    expect(mockBuild).toHaveBeenCalledWith(
      expect.objectContaining({ onlyTransactionKind: true }),
    )
  })
})

// ── session cache expiry ──────────────────────────────────────────────────────

describe('session cache expiry', () => {
  beforeEach(() => {
    clearSessionCache()
    jest.clearAllMocks()
    mockSessionKeyCreate.mockResolvedValue(mockSessionKeyInstance)
    mockGetPersonalMessage.mockReturnValue(new Uint8Array([1, 2, 3]))
    mockSetPersonalMessageSignature.mockResolvedValue(undefined)
    mockEncryptedObjectParse.mockReturnValue({ id: KEYSPACE_ID })
    mockBuild.mockResolvedValue(new Uint8Array([9, 9, 9]))
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('recreates session key when the cached session has expired', async () => {
    const now = 1_000_000
    const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(now)

    await sealDecrypt(makeDecryptOpts())
    expect(mockSessionKeyCreate).toHaveBeenCalledTimes(1)

    // Advance past the default 10-min TTL
    dateSpy.mockReturnValue(now + 11 * 60 * 1000)

    await sealDecrypt(makeDecryptOpts())
    expect(mockSessionKeyCreate).toHaveBeenCalledTimes(2)
  })

  it('reuses session key when it has not yet expired', async () => {
    const now = 1_000_000
    jest.spyOn(Date, 'now').mockReturnValue(now)

    await sealDecrypt(makeDecryptOpts())

    // Advance to just before expiry
    jest.spyOn(Date, 'now').mockReturnValue(now + 9 * 60 * 1000)

    await sealDecrypt(makeDecryptOpts())
    expect(mockSessionKeyCreate).toHaveBeenCalledTimes(1)
  })
})

// ── clearSessionCache ─────────────────────────────────────────────────────────

describe('clearSessionCache', () => {
  it('is exported and callable', () => {
    expect(typeof clearSessionCache).toBe('function')
  })

  it('does not throw when the cache is empty', () => {
    clearSessionCache()
    expect(() => clearSessionCache()).not.toThrow()
  })

  it('can be called multiple times without error', () => {
    clearSessionCache()
    clearSessionCache()
    clearSessionCache()
  })
})
