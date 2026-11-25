/**
 * Which API gateway `getAccessibleAcls` reads from.
 *
 * - `triex` (default): `https://api.trinary.exchange`, with a Trinary Exchange
 *   API key.
 * - `voidwire`: `https://api.voidwire.xyz`, with a Voidwire API key
 *   (`sk_vw_…`).
 *
 * Keys are not shared between the two.
 */
export type KeyspaceGateway = 'triex' | 'voidwire'

/** Base URL of each gateway. */
export const GATEWAY_URLS: Readonly<Record<KeyspaceGateway, string>> = {
  triex: 'https://api.trinary.exchange',
  voidwire: 'https://api.voidwire.xyz',
}

/**
 * The base URL that `/v1/players/…` is appended to. Voidwire serves that route
 * in its `orgs` product group, so its base carries an `/orgs` prefix; overriding
 * `indexerUrl` changes the host only. An explicitly empty `indexerUrl` stays
 * empty, which the client reports as `IndexerRequired`.
 */
export function resolveIndexerUrl(
  gateway: KeyspaceGateway = 'triex',
  indexerUrl?: string,
): string {
  const base = indexerUrl ?? GATEWAY_URLS[gateway]
  if (gateway === 'triex' || base === '') return base
  return `${base.replace(/\/+$/, '')}/orgs`
}
