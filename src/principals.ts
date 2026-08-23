import type { Principal } from './types'
import { AclClientError, AclError } from './errors'

// ── PrincipalV2 kinds ─────────────────────────────────────────────────────────
//
// Mirrors armature_vault::acl::PrincipalV2 { kind: u8, id: address, data }.
// The on-chain kind is *data*, not an enum variant, so new principal kinds
// arrive as new numbers rather than new types — this table is the only place
// the SDK needs to learn one.
//
// `data` is the contract's escape hatch for kinds needing more than an
// identity; every kind below leaves it empty, and the SDK does not surface it
// until a kind uses it.

export const PRINCIPAL_KIND = {
  player: 0,
  ou: 1,
  machine: 2,
} as const

export type PrincipalKindName = keyof typeof PRINCIPAL_KIND

const KIND_TO_NAME: Record<number, PrincipalKindName> = {
  0: 'player',
  1: 'ou',
  2: 'machine',
}

/** The on-chain `kind` tag for an SDK principal. */
export function principalKind(principal: Principal): number {
  switch (principal.type) {
    case 'player':
      return PRINCIPAL_KIND.player
    case 'ou':
      return PRINCIPAL_KIND.ou
    case 'machine':
      return PRINCIPAL_KIND.machine
    default:
      throw new AclClientError(
        AclError.ValidationFailed,
        `Unknown principal type: ${JSON.stringify(principal)}`,
      )
  }
}

/** The on-chain `id` (a 32-byte address) for an SDK principal. */
export function principalId(principal: Principal): string {
  return principal.type === 'ou' ? principal.ouId : principal.address
}

/**
 * Rebuild an SDK principal from an on-chain PrincipalV2. Returns null for a
 * kind this SDK version predates — the contract denies unknown kinds too
 * (`satisfies_v2` fails closed), so dropping it matches on-chain behavior
 * rather than inventing access. Upgrading the SDK is what reveals new kinds.
 */
export function principalFromV2(kind: number, id: string): Principal | null {
  const name = KIND_TO_NAME[kind]
  if (!name) return null
  if (name === 'ou') return { type: 'ou', ouId: id }
  return { type: name, address: id }
}
