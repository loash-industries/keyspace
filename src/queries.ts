import type { AclDetail, AclMeta, EntryMeta, Principal } from './types'
import { AclClientError, AclError } from './errors'

// ── Raw field shapes returned by Sui RPC ──────────────────────────────────────
//
// armature_vault::keyspace::Keyspace fields (showContent: true):
//   id:      { id: string }
//   acl:     { contents: Array<{ key: string, value: unknown[] }> }
//   name:    string
//   version: string | number
//   entries: string[]
//
// armature_vault::keyspace::EncryptedEntry fields:
//   keyspace_id:  string
//   uri:          string
//   description:  string
//   created_by:   string
//   epoch:        string | number

interface RawAclEntry {
  // The Sui TS SDK normalizes outer structs but leaves inner Move enum values
  // as { variant: "Grant"|"Read"|"Write", fields: {} } rather than plain strings.
  key: string | { variant?: string; [k: string]: unknown }
  value: unknown[]
}

interface RawKeyspaceFields {
  name: string
  version: string | number
  entries: string[]
  acl: { contents: RawAclEntry[] }
}

interface RawEncryptedEntryFields {
  keyspace_id: string
  uri: string
  description: string
  created_by: string
  epoch: string | number
}

// ── Principal parsing ─────────────────────────────────────────────────────────
//
// The Sui TS SDK may return Move enum variants in two formats:
//   Normalized:  { "Player": { "addr": "0x..." } }  /  { "Ou": { "dao_id": "0x..." } }
//   Raw RPC:     { "variant": "Player", "fields": { "addr": "0x..." } }
//                { "variant": "Ou",    "fields": { "dao_id": "0x..." } }
// We support both.

function parsePrincipal(raw: unknown): Principal | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>

  // Normalized format
  if ('Player' in obj) {
    const player = obj['Player'] as Record<string, unknown>
    const addr = player?.addr as string | undefined
    if (!addr) return null
    return { type: 'player', address: addr }
  }
  if ('Ou' in obj) {
    const ou = obj['Ou'] as Record<string, unknown>
    const daoId = ou?.dao_id as string | undefined
    if (!daoId) return null
    return { type: 'ou', daoId }
  }

  // Raw RPC { variant, fields } format
  const variant = typeof obj.variant === 'string' ? obj.variant : null
  const fields = (obj.fields ?? {}) as Record<string, unknown>
  if (variant === 'Player') {
    const addr = fields.addr as string | undefined
    if (!addr) return null
    return { type: 'player', address: addr }
  }
  if (variant === 'Ou') {
    const daoId = fields.dao_id as string | undefined
    if (!daoId) return null
    return { type: 'ou', daoId }
  }

  return null
}

function parsePrincipals(raw: unknown[]): Principal[] {
  return raw.flatMap((p) => {
    const parsed = parsePrincipal(p)
    return parsed ? [parsed] : []
  })
}

// The JSON-RPC wraps the VecMap struct in { type, fields: { contents } }.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrapAcl(acl: unknown): RawAclEntry[] {
  const a = acl as any
  return a?.contents ?? a?.fields?.contents ?? []
}

function parseRoleMap(aclContents: RawAclEntry[]): {
  grantPrincipals: Principal[]
  readPrincipals: Principal[]
  writePrincipals: Principal[]
} {
  let grantPrincipals: Principal[] = []
  let readPrincipals: Principal[] = []
  let writePrincipals: Principal[] = []

  for (const rawEntry of aclContents) {
    // The JSON-RPC response wraps VecMap entries in { type, fields: { key, value } }.
    // Handle both the wrapped and the already-unwrapped forms.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry: RawAclEntry = (rawEntry as any)?.fields ?? rawEntry

    const principals = parsePrincipals(
      Array.isArray(entry.value) ? entry.value : [],
    )
    // key is a plain string, { variant: "Grant"|"Read"|"Write", ... }, or
    // the normalized { Grant: {} } form.
    const key = entry.key
    let roleVariant: string | undefined
    if (typeof key === 'string') {
      roleVariant = key
    } else if (key && typeof key === 'object') {
      const k = key as Record<string, unknown>
      roleVariant =
        (k.variant as string | undefined) ??
        (['Grant', 'Read', 'Write'] as const).find((v) => v in k)
    }
    if (roleVariant === 'Grant') grantPrincipals = principals
    else if (roleVariant === 'Read') readPrincipals = principals
    else if (roleVariant === 'Write') writePrincipals = principals
  }

  return { grantPrincipals, readPrincipals, writePrincipals }
}

// ── Queries ───────────────────────────────────────────────────────────────────

export async function fetchKeyspaceMeta(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  suiClient: any,
  keyspaceId: string,
): Promise<AclMeta | null> {
  const res = await suiClient.getObject({
    id: keyspaceId,
    options: { showContent: true },
  })
  const content = res.data?.content
  if (content?.dataType !== 'moveObject') return null
  const fields = content.fields as RawKeyspaceFields
  return {
    id: keyspaceId,
    name: fields.name,
    epoch: Number(fields.version ?? 0),
    entryCount: (fields.entries ?? []).length,
  }
}

export async function fetchKeyspaceDetail(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  suiClient: any,
  keyspaceId: string,
): Promise<AclDetail | null> {
  const res = await suiClient.getObject({
    id: keyspaceId,
    options: { showContent: true },
  })
  const content = res.data?.content
  if (content?.dataType !== 'moveObject') return null
  const fields = content.fields as RawKeyspaceFields

  const epoch = Number(fields.version ?? 0)
  const entryIds: string[] = fields.entries ?? []
  const aclContents = unwrapAcl(fields.acl)

  const { grantPrincipals, readPrincipals, writePrincipals } =
    parseRoleMap(aclContents)

  const entries = await fetchEncryptedEntries(suiClient, entryIds, epoch)

  return {
    id: keyspaceId,
    name: fields.name,
    epoch,
    entryCount: entryIds.length,
    grantPrincipals,
    readPrincipals,
    writePrincipals,
    roles: readPrincipals, // backwards-compat alias
    entries,
  }
}

export async function fetchEncryptedEntry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  suiClient: any,
  entryId: string,
  keyspaceEpoch: number,
): Promise<EntryMeta | null> {
  const res = await suiClient.getObject({
    id: entryId,
    options: { showContent: true },
  })
  const content = res.data?.content
  if (content?.dataType !== 'moveObject') return null
  const fields = content.fields as RawEncryptedEntryFields
  const entryEpoch = Number(fields.epoch ?? 0)
  return {
    id: entryId,
    keyspaceId: fields.keyspace_id,
    uri: fields.uri,
    description: fields.description,
    createdBy: fields.created_by,
    epoch: entryEpoch,
    isStale: entryEpoch < keyspaceEpoch,
  }
}

async function fetchEncryptedEntries(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  suiClient: any,
  entryIds: string[],
  keyspaceEpoch: number,
): Promise<EntryMeta[]> {
  if (entryIds.length === 0) return []
  const res = await suiClient.multiGetObjects({
    ids: entryIds,
    options: { showContent: true },
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (res ?? []).flatMap((obj: any) => {
    const content = obj.data?.content
    if (content?.dataType !== 'moveObject') return []
    const fields = content.fields as RawEncryptedEntryFields
    const entryEpoch = Number(fields.epoch ?? 0)
    return [
      {
        id: obj.data.objectId as string,
        keyspaceId: fields.keyspace_id,
        uri: fields.uri,
        description: fields.description,
        createdBy: fields.created_by,
        epoch: entryEpoch,
        isStale: entryEpoch < keyspaceEpoch,
      } satisfies EntryMeta,
    ]
  })
}

// @todo:add-indexer — replace with GET ${indexerUrl}/v1/address/:address/keyspaces
export async function fetchAccessibleKeyspaces(
  indexerUrl: string,
  address: string,
): Promise<string[]> {
  const res = await fetch(`${indexerUrl}/v1/address/${address}/keyspaces`)
  if (!res.ok) {
    throw new AclClientError(
      AclError.UnexpectedResponse,
      `Indexer error (${res.status}): ${res.statusText}`,
    )
  }
  const { keyspaceIds } = (await res.json()) as { keyspaceIds: string[] }
  return keyspaceIds
}
