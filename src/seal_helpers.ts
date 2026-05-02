import { SessionKey, EncryptedObject } from '@mysten/seal'
import { Transaction } from '@mysten/sui/transactions'
import { fromHex, toHex } from '@mysten/sui/utils'
import type { SignPersonalMessageFn } from './types.js'

const SESSION_TTL_MIN = 10

// ── In-memory session key cache ───────────────────────────────────────────────

interface CachedSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  key: any // SessionKey — typed as any to avoid peer-dep version conflicts
  address: string
  expiresAt: number
}

const sessionCache = new Map<string, CachedSession>()

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
}

// ── Encrypt ───────────────────────────────────────────────────────────────────

/**
 * Encrypts data using Seal threshold encryption keyed to an AllowList.
 *
 * Policy ID = allowlistId_bytes (32) || random_nonce (5), hex-encoded.
 * This is checked against `seal_approve` which verifies the first 32 bytes
 * match the AllowList UID.
 */
export async function sealEncrypt(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sealClient: any,
  packageId: string,
  allowlistId: string,
  data: Uint8Array,
): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(5))
  const allowlistBytes = fromHex(allowlistId)
  const id = toHex(new Uint8Array([...allowlistBytes, ...nonce]))

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
  allowlistId: string
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
    allowlistId,
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

  // Parse the encrypted object to get the policy ID that was used during encryption
  const parsed = EncryptedObject.parse(encryptedData)

  // Build the seal_approve PTB (transaction kind only — not a full tx)
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::acl_encrypt::seal_approve`,
    arguments: [
      tx.pure.vector('u8', fromHex(parsed.id)),
      tx.object(allowlistId),
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
