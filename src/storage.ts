import type { StorageAdapter } from './types'
import { AclClientError, AclError } from './errors'

// ── Helpers ───────────────────────────────────────────────────────────────────

function uint8ToHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function hexToUint8(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string length')
  const buf = new Uint8Array(hex.length / 2)
  for (let i = 0; i < buf.length; i++) {
    buf[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return buf
}

// ── Pinata IPFS adapter ───────────────────────────────────────────────────────

export interface PinataStorageConfig {
  jwt: string
  gateway?: string
}

/**
 * StorageAdapter backed by Pinata (IPFS).
 *
 * Encrypted blobs are stored as JSON { blob: "<hex>" } so they are text-safe
 * and compatible with Pinata's JSON pinning endpoint.
 */
export class PinataStorageAdapter implements StorageAdapter {
  private readonly jwt: string
  private readonly gateway: string

  constructor(config: PinataStorageConfig) {
    this.jwt = config.jwt
    this.gateway = config.gateway ?? 'https://gateway.pinata.cloud'
  }

  async upload(data: Uint8Array, name?: string): Promise<string> {
    const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.jwt}`,
      },
      body: JSON.stringify({
        pinataContent: { blob: uint8ToHex(data) },
        pinataMetadata: { name: name ?? 'acl-sdk-entry' },
      }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new AclClientError(
        AclError.StorageUploadFailed,
        `Pinata upload failed (${res.status}): ${text}`,
      )
    }

    const { IpfsHash } = (await res.json()) as { IpfsHash: string }
    return `ipfs://${IpfsHash}`
  }

  async download(uri: string): Promise<Uint8Array> {
    const cid = uri.startsWith('ipfs://') ? uri.slice(7) : uri
    const url = `${this.gateway}/ipfs/${cid}`
    const res = await fetch(url)

    if (!res.ok) {
      throw new AclClientError(
        AclError.StorageFetchFailed,
        `IPFS fetch failed (${res.status}): ${res.statusText}`,
      )
    }

    const { blob } = (await res.json()) as { blob: string }
    return hexToUint8(blob)
  }
}

// ── Object store adapter ──────────────────────────────────────────────────────

/**
 * Minimal interface an object-store client must satisfy.
 * Implement this directly for any provider (MinIO, Cloudflare R2, GCS, etc.),
 * or use the provided S3ObjectStoreClient for AWS S3 / S3-compatible services.
 */
export interface ObjectStoreClient {
  put(bucket: string, key: string, data: Uint8Array): Promise<void>
  get(bucket: string, key: string): Promise<Uint8Array>
}

export interface ObjectStoreStorageConfig {
  /** The client that performs the actual put/get operations. */
  client: ObjectStoreClient
  /** Bucket (or container) name. */
  bucket: string
  /**
   * Base URL for constructing https:// location URIs.
   * Example: "https://my-bucket.s3.amazonaws.com"
   */
  baseUrl: string
  /**
   * Key prefix applied to every stored object.
   * Defaults to "acl-sdk/".
   */
  prefix?: string
}

/**
 * StorageAdapter backed by any S3-compatible or custom object store.
 *
 * The `location` returned by upload() is a full https:// URL constructed from
 * the configured baseUrl and the object key (prefix + name).
 */
export class ObjectStoreStorageAdapter implements StorageAdapter {
  private readonly client: ObjectStoreClient
  private readonly bucket: string
  private readonly baseUrl: string
  private readonly prefix: string

  constructor(config: ObjectStoreStorageConfig) {
    this.client = config.client
    this.bucket = config.bucket
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.prefix = config.prefix ?? 'acl-sdk/'
  }

  async upload(data: Uint8Array, name?: string): Promise<string> {
    const key = this.prefix + (name ?? crypto.randomUUID())
    try {
      await this.client.put(this.bucket, key, data)
    } catch (err) {
      throw new AclClientError(
        AclError.StorageUploadFailed,
        `Object store upload failed: ${(err as Error).message ?? String(err)}`,
        err,
      )
    }
    return `${this.baseUrl}/${key}`
  }

  async download(uri: string): Promise<Uint8Array> {
    const prefix = `${this.baseUrl}/`
    const key = uri.startsWith(prefix) ? uri.slice(prefix.length) : uri
    try {
      return await this.client.get(this.bucket, key)
    } catch (err) {
      throw new AclClientError(
        AclError.StorageFetchFailed,
        `Object store fetch failed: ${(err as Error).message ?? String(err)}`,
        err,
      )
    }
  }
}

// ── S3 concrete client ────────────────────────────────────────────────────────

export interface S3ObjectStoreClientConfig {
  /**
   * AWS region (e.g. 'us-east-1'). For S3-compatible services use any
   * non-empty string (e.g. 'auto').
   */
  region: string
  /**
   * Custom endpoint URL for S3-compatible services (R2, MinIO, DigitalOcean
   * Spaces, etc.). Omit for standard AWS S3.
   */
  endpoint?: string
  /**
   * Explicit credentials. When omitted the SDK falls back to the default
   * credential provider chain (env vars, IAM role, etc.).
   */
  credentials?: {
    accessKeyId: string
    secretAccessKey: string
  }
}

/**
 * ObjectStoreClient implementation wrapping @aws-sdk/client-s3.
 *
 * The S3Client is constructed internally so consumers of @trinaryex/keyspace
 * never need to import @aws-sdk/client-s3 directly.
 *
 * @example
 * ```ts
 * import { S3ObjectStoreClient, ObjectStoreStorageAdapter } from '@trinaryex/keyspace';
 *
 * // AWS S3
 * const s3 = new S3ObjectStoreClient({ region: 'us-east-1' });
 *
 * // S3-compatible (e.g. MinIO, Cloudflare R2)
 * const r2 = new S3ObjectStoreClient({
 *   region: 'auto',
 *   endpoint: 'https://<account>.r2.cloudflarestorage.com',
 *   credentials: { accessKeyId: '...', secretAccessKey: '...' },
 * });
 *
 * const adapter = new ObjectStoreStorageAdapter({
 *   client: s3, // or r2
 *   bucket: 'my-bucket',
 *   baseUrl: 'https://my-bucket.s3.us-east-1.amazonaws.com',
 * });
 * ```
 */
// Lazy-cached dynamic import so @aws-sdk/client-s3 is only loaded when
// S3ObjectStoreClient is actually used (it's an optional peer dep).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let s3ModulePromise: Promise<typeof import('@aws-sdk/client-s3')> | null = null
function getS3Module(): Promise<typeof import('@aws-sdk/client-s3')> {
  if (!s3ModulePromise) {
    s3ModulePromise = import('@aws-sdk/client-s3')
  }
  return s3ModulePromise
}

export class S3ObjectStoreClient implements ObjectStoreClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private s3: any
  private readonly config: S3ObjectStoreClientConfig
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private s3Ready: Promise<any> | null = null

  constructor(config: S3ObjectStoreClientConfig) {
    this.config = config
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getClient(): Promise<any> {
    if (!this.s3Ready) {
      this.s3Ready = getS3Module().then(({ S3Client }) => {
        this.s3 = new S3Client({
          region: this.config.region,
          ...(this.config.endpoint ? { endpoint: this.config.endpoint } : {}),
          ...(this.config.credentials
            ? { credentials: this.config.credentials }
            : {}),
        })
        return this.s3
      })
    }
    return this.s3Ready
  }

  async put(bucket: string, key: string, data: Uint8Array): Promise<void> {
    const [s3, { PutObjectCommand }] = await Promise.all([
      this.getClient(),
      getS3Module(),
    ])
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: data,
        ContentType: 'application/octet-stream',
      }),
    )
  }

  async get(bucket: string, key: string): Promise<Uint8Array> {
    const [s3, { GetObjectCommand }] = await Promise.all([
      this.getClient(),
      getS3Module(),
    ])
    const res = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    )

    if (!res.Body) {
      throw new Error(`Empty response body for key: ${key}`)
    }

    // res.Body is a SdkStreamMixin in Node.js environments
    return res.Body.transformToByteArray()
  }
}

// ── Download URL resolver ─────────────────────────────────────────────────────

/**
 * Resolve a protocol-denominated URI to a downloadable HTTP(S) URL.
 *
 * - `ipfs://` URIs are rewritten using the provided `ipfsGatewayUrl`.
 * - `https://` URIs are returned as-is (they are already downloadable).
 */
export function getDownloadUrl(uri: string, ipfsGatewayUrl?: string): string {
  if (uri.startsWith('ipfs://')) {
    if (!ipfsGatewayUrl) {
      throw new AclClientError(
        AclError.StorageFetchFailed,
        'An IPFS gateway URL is required to resolve ipfs:// URIs',
      )
    }
    const cid = uri.slice(7)
    return `${ipfsGatewayUrl.replace(/\/$/, '')}/ipfs/${cid}`
  }
  return uri
}
