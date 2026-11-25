/**
 * Which API gateway `getAccessibleAcls` reads from.
 *
 * - `voidwire` (default): `https://api.voidwire.xyz`, with a Voidwire API key
 *   (`sk_vw_…`).
 * - `triex`: `https://api.trinary.exchange`, with a Trinary Exchange API key.
 *
 * Keys are not shared between the two.
 */
export type KeyspaceGateway = 'triex' | 'voidwire'

/** Base URL of each gateway. */
export const GATEWAY_URLS: Readonly<Record<KeyspaceGateway, string>> = {
  triex: 'https://api.trinary.exchange',
  voidwire: 'https://api.voidwire.xyz',
}

/** The gateway used when a client is given none: Voidwire. */
export const DEFAULT_GATEWAY: KeyspaceGateway = 'voidwire'

/**
 * The gateway a client reads through. An explicit `gateway` wins. Without one,
 * an `indexerUrl` that is the Trinary Exchange gateway's own URL keeps that
 * gateway's path layout, so a config that already names it keeps working;
 * anything else gets the default, Voidwire.
 */
export function resolveGateway(
  gateway?: KeyspaceGateway,
  indexerUrl?: string,
): KeyspaceGateway {
  if (gateway) return gateway
  if (indexerUrl && sameOrigin(indexerUrl, GATEWAY_URLS.triex)) return 'triex'
  return DEFAULT_GATEWAY
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

/**
 * The base URL that `/v1/players/…` is appended to. Voidwire serves that route
 * in its `orgs` product group, so its base carries an `/orgs` prefix; overriding
 * `indexerUrl` changes the host only. An explicitly empty `indexerUrl` stays
 * empty, which the client reports as `IndexerRequired`.
 */
export function resolveIndexerUrl(
  gateway?: KeyspaceGateway,
  indexerUrl?: string,
): string {
  gateway = resolveGateway(gateway, indexerUrl)
  const base = indexerUrl ?? GATEWAY_URLS[gateway]
  if (gateway === 'triex' || base === '') return base
  return `${base.replace(/\/+$/, '')}/orgs`
}

/**
 * Advice for a 401/403. Voidwire keys start `sk_vw_`; any other key sent to
 * Voidwire is almost certainly a Trinary Exchange key on a client that took
 * the default gateway, so name the fix.
 */
export function unauthorizedHint(
  gateway: KeyspaceGateway,
  apiKey: string,
): string {
  if (gateway === 'voidwire' && !apiKey.startsWith('sk_vw_')) {
    return "Keyspace reads through Voidwire by default, which takes Voidwire keys (sk_vw_…). For a Trinary Exchange key, pass gateway: 'triex'."
  }
  return 'Check your API key and that it belongs to the configured gateway.'
}
