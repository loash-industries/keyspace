import { jest } from '@jest/globals'
import {
  PinataStorageAdapter,
  ObjectStoreStorageAdapter,
  S3ObjectStoreClient,
  getDownloadUrl,
} from '../src/storage'
import type { ObjectStoreClient } from '../src/storage'
import { AclError, AclClientError } from '../src/errors'

// ── PinataStorageAdapter ──────────────────────────────────────────────────────

describe('PinataStorageAdapter', () => {
  const JWT = 'test-jwt-token'
  const CID = 'QmTestCidHash'
  const DATA = new Uint8Array([0x01, 0x02, 0xff, 0x00, 0xab])
  // hex of DATA
  const HEX = '0102ff00ab'

  let fetchMock: any

  beforeEach(() => {
    fetchMock = jest.fn()
    ;(global as any).fetch = fetchMock
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('upload', () => {
    it('uploads data to Pinata and returns the IPFS hash', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ IpfsHash: CID }),
        text: async () => '',
      })
      const adapter = new PinataStorageAdapter({ jwt: JWT })

      const result = await adapter.upload(DATA)

      expect(result).toBe(`ipfs://${CID}`)
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.pinata.cloud/pinning/pinJSONToIPFS',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Bearer ${JWT}`,
            'Content-Type': 'application/json',
          }),
          body: expect.stringContaining(HEX),
        }),
      )
    })

    it('uses default name when none is provided', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ IpfsHash: CID }),
      })
      const adapter = new PinataStorageAdapter({ jwt: JWT })
      await adapter.upload(DATA)

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
      expect(body.pinataMetadata.name).toBe('acl-sdk-entry')
    })

    it('uses a custom name when provided', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ IpfsHash: CID }),
      })
      const adapter = new PinataStorageAdapter({ jwt: JWT })
      await adapter.upload(DATA, 'custom-name')

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
      expect(body.pinataMetadata.name).toBe('custom-name')
    })

    it('throws AclClientError(StorageUploadFailed) on HTTP error', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => 'Bad Request',
      })
      const adapter = new PinataStorageAdapter({ jwt: JWT })

      await expect(adapter.upload(DATA)).rejects.toThrow(AclClientError)
      await expect(adapter.upload(DATA)).rejects.toMatchObject({
        code: AclError.StorageUploadFailed,
      })
    })
  })

  describe('download', () => {
    it('downloads and decodes data from IPFS via the default gateway', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ blob: HEX }),
      })
      const adapter = new PinataStorageAdapter({ jwt: JWT })

      const result = await adapter.download(`ipfs://${CID}`)

      expect(result).toEqual(DATA)
      expect(fetchMock).toHaveBeenCalledWith(
        `https://gateway.pinata.cloud/ipfs/${CID}`,
      )
    })

    it('uses a custom gateway when configured', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ blob: HEX }),
      })
      const adapter = new PinataStorageAdapter({
        jwt: JWT,
        gateway: 'https://custom.gw',
      })

      await adapter.download(`ipfs://${CID}`)

      expect(fetchMock).toHaveBeenCalledWith(`https://custom.gw/ipfs/${CID}`)
    })

    it('throws AclClientError(StorageFetchFailed) on HTTP error', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      })
      const adapter = new PinataStorageAdapter({ jwt: JWT })

      await expect(adapter.download(`ipfs://${CID}`)).rejects.toThrow(
        AclClientError,
      )
      await expect(adapter.download(`ipfs://${CID}`)).rejects.toMatchObject({
        code: AclError.StorageFetchFailed,
      })
    })
  })

  describe('hex round-trip', () => {
    it('data survives an upload→download round-trip (in-memory)', async () => {
      let stored = ''

      fetchMock
        .mockImplementationOnce(async (_url: string, init: RequestInit) => {
          const parsed = JSON.parse(init.body as string)
          stored = parsed.pinataContent.blob as string
          return {
            ok: true,
            status: 200,
            json: async () => ({ IpfsHash: CID }),
          }
        })
        .mockImplementationOnce(async () => ({
          ok: true,
          status: 200,
          json: async () => ({ blob: stored }),
        }))

      const adapter = new PinataStorageAdapter({ jwt: JWT })
      const original = new Uint8Array([10, 20, 30, 255, 0, 128])

      await adapter.upload(original)
      const recovered = await adapter.download(`ipfs://${CID}`)

      expect(recovered).toEqual(original)
    })
  })
})

// ── ObjectStoreStorageAdapter ─────────────────────────────────────────────────

describe('ObjectStoreStorageAdapter', () => {
  const BUCKET = 'test-bucket'
  const BASE_URL = 'https://test-bucket.s3.amazonaws.com'
  const DATA = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
  const KEY = 'acl-sdk/some-key'

  let mockClient: jest.Mocked<ObjectStoreClient>

  beforeEach(() => {
    mockClient = {
      put: jest.fn<ObjectStoreClient['put']>(),
      get: jest.fn<ObjectStoreClient['get']>(),
    }
  })

  describe('upload', () => {
    it('calls client.put with the bucket and a prefixed key, returns the key', async () => {
      mockClient.put.mockResolvedValue(undefined)
      const adapter = new ObjectStoreStorageAdapter({
        client: mockClient,
        bucket: BUCKET,
        baseUrl: BASE_URL,
      })

      const result = await adapter.upload(DATA)

      expect(mockClient.put).toHaveBeenCalledWith(
        BUCKET,
        expect.stringMatching(/^acl-sdk\//),
        DATA,
      )
      expect(result).toMatch(
        new RegExp(
          `^${BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/acl-sdk/`,
        ),
      )
    })

    it('uses a custom prefix when configured', async () => {
      mockClient.put.mockResolvedValue(undefined)
      const adapter = new ObjectStoreStorageAdapter({
        client: mockClient,
        bucket: BUCKET,
        baseUrl: BASE_URL,
        prefix: 'custom/',
      })

      const result = await adapter.upload(DATA)

      expect(result).toMatch(
        new RegExp(
          `^${BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/custom/`,
        ),
      )
      expect(mockClient.put).toHaveBeenCalledWith(
        BUCKET,
        expect.stringMatching(/^custom\//),
        DATA,
      )
    })

    it('uses the provided name as the key suffix', async () => {
      mockClient.put.mockResolvedValue(undefined)
      const adapter = new ObjectStoreStorageAdapter({
        client: mockClient,
        bucket: BUCKET,
        baseUrl: BASE_URL,
      })

      const result = await adapter.upload(DATA, 'my-blob')

      expect(result).toBe(`${BASE_URL}/acl-sdk/my-blob`)
      expect(mockClient.put).toHaveBeenCalledWith(
        BUCKET,
        'acl-sdk/my-blob',
        DATA,
      )
    })

    it('wraps client errors in AclClientError(StorageUploadFailed)', async () => {
      mockClient.put.mockRejectedValue(new Error('network error'))
      const adapter = new ObjectStoreStorageAdapter({
        client: mockClient,
        bucket: BUCKET,
        baseUrl: BASE_URL,
      })

      await expect(adapter.upload(DATA)).rejects.toMatchObject({
        code: AclError.StorageUploadFailed,
      })
    })
  })

  describe('download', () => {
    it('calls client.get with the bucket and the given key, returns data', async () => {
      mockClient.get.mockResolvedValue(DATA)
      const adapter = new ObjectStoreStorageAdapter({
        client: mockClient,
        bucket: BUCKET,
        baseUrl: BASE_URL,
      })

      const result = await adapter.download(`${BASE_URL}/${KEY}`)

      expect(mockClient.get).toHaveBeenCalledWith(BUCKET, KEY)
      expect(result).toEqual(DATA)
    })

    it('wraps client errors in AclClientError(StorageFetchFailed)', async () => {
      mockClient.get.mockRejectedValue(new Error('not found'))
      const adapter = new ObjectStoreStorageAdapter({
        client: mockClient,
        bucket: BUCKET,
        baseUrl: BASE_URL,
      })

      await expect(
        adapter.download(`${BASE_URL}/${KEY}`),
      ).rejects.toMatchObject({
        code: AclError.StorageFetchFailed,
      })
    })
  })

  describe('round-trip', () => {
    it('data survives an upload→download round-trip via the mock client', async () => {
      const store = new Map<string, Uint8Array>()
      mockClient.put.mockImplementation(async (_b, key, data) => {
        store.set(key, data)
      })
      mockClient.get.mockImplementation(async (_b, key) => {
        const v = store.get(key)
        if (!v) throw new Error('not found')
        return v
      })

      const adapter = new ObjectStoreStorageAdapter({
        client: mockClient,
        bucket: BUCKET,
        baseUrl: BASE_URL,
      })
      const original = new Uint8Array([1, 2, 3, 255, 0])

      const key = await adapter.upload(original)
      const recovered = await adapter.download(key)

      expect(recovered).toEqual(original)
    })
  })
})

// ── S3ObjectStoreClient ───────────────────────────────────────────────────────

describe('S3ObjectStoreClient', () => {
  const BUCKET = 'my-bucket'
  const BASE_URL = 'https://my-bucket.s3.amazonaws.com'
  const KEY = 'acl-sdk/abc'
  const DATA = new Uint8Array([0x01, 0x02, 0x03])

  let sendMock: jest.Mock<any>

  beforeEach(() => {
    sendMock = jest.fn()
  })

  function makeClient() {
    // S3ObjectStoreClient now lazily creates the S3Client internally.
    // We instantiate with dummy config and override the lazy init to use our mock.
    const client = new S3ObjectStoreClient({ region: 'us-east-1' })
    // Short-circuit the lazy init so no real S3Client is ever created.
    const fake = { send: sendMock }
    ;(client as any).s3 = fake
    ;(client as any).s3Ready = Promise.resolve(fake)
    return client
  }

  describe('put', () => {
    it('sends a PutObjectCommand with the correct bucket, key, and body', async () => {
      sendMock.mockResolvedValue({})
      const client = makeClient()

      await client.put(BUCKET, KEY, DATA)

      expect(sendMock).toHaveBeenCalledTimes(1)
      const [cmd] = sendMock.mock.calls[0] as any[]
      expect(cmd.constructor.name).toBe('PutObjectCommand')
      expect(cmd.input).toMatchObject({
        Bucket: BUCKET,
        Key: KEY,
        Body: DATA,
        ContentType: 'application/octet-stream',
      })
    })

    it('propagates errors from the S3 client', async () => {
      sendMock.mockRejectedValue(new Error('S3 error'))
      const client = makeClient()

      await expect(client.put(BUCKET, KEY, DATA)).rejects.toThrow('S3 error')
    })
  })

  describe('get', () => {
    it('sends a GetObjectCommand and converts the body to Uint8Array', async () => {
      const transformToByteArray = jest
        .fn<() => Promise<Uint8Array>>()
        .mockResolvedValue(DATA)
      sendMock.mockResolvedValue({ Body: { transformToByteArray } })
      const client = makeClient()

      const result = await client.get(BUCKET, KEY)

      expect(sendMock).toHaveBeenCalledTimes(1)
      const [cmd] = sendMock.mock.calls[0] as any[]
      expect(cmd.constructor.name).toBe('GetObjectCommand')
      expect(cmd.input).toMatchObject({ Bucket: BUCKET, Key: KEY })
      expect(result).toEqual(DATA)
    })

    it('throws when response Body is missing', async () => {
      sendMock.mockResolvedValue({ Body: undefined })
      const client = makeClient()

      await expect(client.get(BUCKET, KEY)).rejects.toThrow(
        /Empty response body/,
      )
    })

    it('propagates errors from the S3 client', async () => {
      sendMock.mockRejectedValue(new Error('NoSuchKey'))
      const client = makeClient()

      await expect(client.get(BUCKET, KEY)).rejects.toThrow('NoSuchKey')
    })
  })

  describe('end-to-end with ObjectStoreStorageAdapter', () => {
    it('wraps S3 errors as AclClientError(StorageUploadFailed)', async () => {
      sendMock.mockRejectedValue(new Error('Access Denied'))
      const client = makeClient()
      const adapter = new ObjectStoreStorageAdapter({
        client,
        bucket: BUCKET,
        baseUrl: BASE_URL,
      })

      await expect(adapter.upload(DATA)).rejects.toMatchObject({
        code: AclError.StorageUploadFailed,
      })
    })

    it('wraps S3 errors as AclClientError(StorageFetchFailed)', async () => {
      sendMock.mockRejectedValue(new Error('NoSuchKey'))
      const client = makeClient()
      const adapter = new ObjectStoreStorageAdapter({
        client,
        bucket: BUCKET,
        baseUrl: BASE_URL,
      })

      await expect(adapter.download('acl-sdk/missing')).rejects.toMatchObject({
        code: AclError.StorageFetchFailed,
      })
    })
  })
})

// ── getDownloadUrl ────────────────────────────────────────────────────────────

describe('getDownloadUrl', () => {
  it('resolves ipfs:// locations using the provided gateway URL', () => {
    const result = getDownloadUrl(
      'ipfs://QmTestHash',
      'https://gateway.pinata.cloud',
    )
    expect(result).toBe('https://gateway.pinata.cloud/ipfs/QmTestHash')
  })

  it('strips trailing slash from the gateway URL', () => {
    const result = getDownloadUrl(
      'ipfs://QmTestHash',
      'https://gateway.pinata.cloud/',
    )
    expect(result).toBe('https://gateway.pinata.cloud/ipfs/QmTestHash')
  })

  it('throws when ipfs:// location is used without a gateway URL', () => {
    expect(() => getDownloadUrl('ipfs://QmTestHash')).toThrow(AclClientError)
    expect(() => getDownloadUrl('ipfs://QmTestHash')).toThrow(
      /IPFS gateway URL/,
    )
  })

  it('returns https:// locations as-is', () => {
    const url = 'https://my-bucket.s3.amazonaws.com/acl-sdk/my-key'
    expect(getDownloadUrl(url)).toBe(url)
  })

  it('returns https:// locations as-is even when a gateway is provided', () => {
    const url = 'https://my-bucket.s3.amazonaws.com/acl-sdk/my-key'
    expect(getDownloadUrl(url, 'https://gateway.pinata.cloud')).toBe(url)
  })
})
