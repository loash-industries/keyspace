import type { SignPersonalMessageFn } from './types'

// ── Keypair-backed signing ────────────────────────────────────────────────────
//
// Server-side consumers (machine keys) hold an Ed25519 keypair instead of a
// wallet. The decrypt path only needs a wallet address and a
// SignPersonalMessageFn; this adapter derives both from the keypair so a
// service can call readData without hand-rolling the callback.

/**
 * Structural view of the keypair surface this adapter needs — satisfied by
 * `Ed25519Keypair` from `@mysten/sui/keypairs/ed25519` (and any compatible
 * keypair type), without importing the class here.
 */
export interface PersonalMessageKeypair {
  getPublicKey(): { toSuiAddress(): string }
  signPersonalMessage(message: Uint8Array): Promise<{ signature: string }>
}

export interface KeypairSigner {
  walletAddress: string
  signPersonalMessage: SignPersonalMessageFn
}

/**
 * Adapt a server-held keypair to the `{ walletAddress, signPersonalMessage }`
 * pair that `readData` / `LocationsClient` / `MachinesClient` expect:
 *
 * ```ts
 * const { walletAddress, signPersonalMessage } = keypairSigner(keypair)
 * const plaintext = await acl.readData({
 *   aclId, entryId, walletAddress, signPersonalMessage, ouId,
 * })
 * ```
 *
 * Intended for machine keys — keypairs granted Read as a
 * `{ type: 'machine' }` principal and held by server-side services. Session
 * keys created through this signer are cached in process memory only (see
 * `clearSessionCache`); never persist them.
 */
export function keypairSigner(keypair: PersonalMessageKeypair): KeypairSigner {
  return {
    walletAddress: keypair.getPublicKey().toSuiAddress(),
    signPersonalMessage: async (message) =>
      (await keypair.signPersonalMessage(message)).signature,
  }
}
