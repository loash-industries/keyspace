import { SessionKey, EncryptedObject } from '@mysten/seal'
import { Transaction } from '@mysten/sui/transactions'
import { fromHex, toHex } from '@mysten/sui/utils'
import type { SignPersonalMessageFn } from './types'

const SESSION_TTL_MIN = 10

// ── In-memory session key cache ───────────────────────────────────────────────

interface CachedSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  key: any
  address: string
  expiresAt: number
}

const sessionCache = new Map<string, CachedSession>()
// Inflight promises keyed by address — concurrent callers share one signing
// request instead of each creating a distinct session key and racing to the wallet.
const inflightSessions = new Map<string, Promise<SessionKey>>()

function getCachedSession(address: string): CachedSession | null {
  const cached = sessionCache.get(address)
  if (!cached) return null
  if (Date.now() >= cached.expiresAt) {
    sessionCache.delete(address)
    return null
  }
  return cached
}

function setCachedSession(
  address: string,
  key: SessionKey,
  ttlMin: number,
): void {
  sessionCache.set(address, {
    key,
    address,
    expiresAt: Date.now() + ttlMin * 60 * 1000,
  })
}

export function clearSessionCache(): void {
  sessionCache.clear()
  inflightSessions.clear()
}

// ── Session key management ────────────────────────────────────────────────────

async function getOrCreateSessionKey(
  address: string,
  packageId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  suiClient: any,
  signPersonalMessage: SignPersonalMessageFn,
  ttlMin: number,
): Promise<SessionKey> {
  const cached = getCachedSession(address)
  if (cached) return cached.key as SessionKey

  // If another caller is already creating a session key for this address,
  // wait for that promise rather than triggering a second wallet signing prompt.
  const inflight = inflightSessions.get(address)
  if (inflight) return inflight

  const promise = (async () => {
    const sessionKey = await SessionKey.create({
      address,
      packageId,
      ttlMin,
      suiClient,
    })

    const signature = await signPersonalMessage(sessionKey.getPersonalMessage())
    await sessionKey.setPersonalMessageSignature(signature)

    setCachedSession(address, sessionKey, ttlMin)
    return sessionKey
  })()

  inflightSessions.set(address, promise)
  try {
    return await promise
  } finally {
    inflightSessions.delete(address)
  }
}

// ── Encrypt ───────────────────────────────────────────────────────────────────

/**
 * Encrypts `data` using Seal threshold encryption keyed to a Keyspace.
 *
 * Policy ID = keyspaceId_bytes (32) || random_nonce (5), hex-encoded.
 * `keyspace::seal_approve` verifies the first 32 bytes match the Keyspace UID.
 */
export async function sealEncrypt(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sealClient: any,
  packageId: string,
  keyspaceId: string,
  data: Uint8Array,
): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(5))
  const keyspaceBytes = fromHex(keyspaceId)
  const id = toHex(new Uint8Array([...keyspaceBytes, ...nonce]))

  const { encryptedObject } = await sealClient.encrypt({
    threshold: 1,
    packageId,
    id,
    data,
  })

  return encryptedObject
}

// ── Decrypt ───────────────────────────────────────────────────────────────────

export interface DecryptOptions {
  packageId: string
  keyspaceId: string
  /** DAO object ID — required by keyspace::seal_approve. */
  daoId: string
  encryptedData: Uint8Array
  walletAddress: string
  signPersonalMessage: SignPersonalMessageFn
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  suiClient: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sealClient: any
  sessionKeyTtlMin?: number
}

export async function sealDecrypt(opts: DecryptOptions): Promise<Uint8Array> {
  const {
    packageId,
    keyspaceId,
    daoId,
    encryptedData,
    walletAddress,
    signPersonalMessage,
    suiClient,
    sealClient,
    sessionKeyTtlMin = SESSION_TTL_MIN,
  } = opts

  const sessionKey = await getOrCreateSessionKey(
    walletAddress,
    packageId,
    suiClient,
    signPersonalMessage,
    sessionKeyTtlMin,
  )

  const parsed = EncryptedObject.parse(encryptedData)

  // Build the seal_approve PTB:
  // entry fun seal_approve(id: vector<u8>, keyspace: &Keyspace, dao: &DAO, ctx: &TxContext)
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::keyspace::seal_approve`,
    arguments: [
      tx.pure.vector('u8', fromHex(parsed.id)),
      tx.object(keyspaceId),
      tx.object(daoId),
    ],
  })
  const txBytes = await tx.build({
    client: suiClient,
    onlyTransactionKind: true,
  })

  const plaintext = await sealClient.decrypt({
    data: encryptedData,
    sessionKey,
    txBytes,
  })

  return plaintext
}
