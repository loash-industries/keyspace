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
  key: string // 'Grant' | 'Read' | 'Write'
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
// Sui serializes Move enum variants with fields as { VariantName: { ...fields } }
// e.g. Principal::Player { addr } → { "Player": { "addr": "0x..." } }
//      Principal::Ou { dao_id }   → { "Ou": { "dao_id": "0x..." } }

function parsePrincipal(raw: unknown): Principal | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>

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

  return null
}

function parsePrincipals(raw: unknown[]): Principal[] {
  return raw.flatMap((p) => {
    const parsed = parsePrincipal(p)
    return parsed ? [parsed] : []
  })
}

function parseRoleMap(aclContents: RawAclEntry[]): {
  grantPrincipals: Principal[]
  readPrincipals: Principal[]
  writePrincipals: Principal[]
} {
  let grantPrincipals: Principal[] = []
  let readPrincipals: Principal[] = []
  let writePrincipals: Principal[] = []

  for (const entry of aclContents) {
    const principals = parsePrincipals(Array.isArray(entry.value) ? entry.value : [])
    if (entry.key === 'Grant') grantPrincipals = principals
    else if (entry.key === 'Read') readPrincipals = principals
    else if (entry.key === 'Write') writePrincipals = principals
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
  const aclContents: RawAclEntry[] = fields.acl?.contents ?? []

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
