import type { AclDetail, AclMeta, EntryMeta, Principal } from './types'
import { AclClientError, AclError } from './errors'
import { principalFromV2 } from './principals'

// ── Raw field shapes returned by Sui RPC ──────────────────────────────────────
//
// Fetched via the unified core API (`core.getObject`/`core.getObjects` with
// `include: { json: true }`), which returns the object's Move struct as a JSON
// object. Nested-struct field names may differ from the legacy JSON-RPC shape,
// so the parsers below defensively accept both (see `unwrapAcl`/`parsePrincipal`).
//
// armature_vault::keyspace::Keyspace fields:
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
// Sui clients return Move enum variants in three formats:
//   Normalized:  { "Player": { "addr": "0x..." } }  /  { "Ou": { "dao_id": "0x..." } }
//   Raw JSON-RPC:{ "variant": "Player", "fields": { "addr": "0x..." } }
//                { "variant": "Ou",    "fields": { "dao_id": "0x..." } }
//   gRPC core:   { "@variant": "Player", "addr": "0x..." }   (fields inlined)
//                { "@variant": "Ou",    "dao_id": "0x..." }
// We support all three. This is the v1 enum only — it is frozen at Player/Ou,
// so machine (and every later kind) arrives instead as a PrincipalV2 from the
// v2 ACL, merged into the same role sets by fetchPrincipalRoleMapV2 below.

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
    const ouId = ou?.dao_id as string | undefined
    if (!ouId) return null
    return { type: 'ou', ouId }
  }
  // gRPC core-json format: { "@variant": "Player"|"Ou", ...inlined fields }
  const atVariant =
    typeof obj['@variant'] === 'string' ? (obj['@variant'] as string) : null
  if (atVariant === 'Player') {
    const addr = obj.addr as string | undefined
    if (!addr) return null
    return { type: 'player', address: addr }
  }
  if (atVariant === 'Ou') {
    const ouId = obj.dao_id as string | undefined
    if (!ouId) return null
    return { type: 'ou', ouId }
  }
  // Raw JSON-RPC { variant, fields } format
  const variant = typeof obj.variant === 'string' ? obj.variant : null
  const fields = (obj.fields ?? {}) as Record<string, unknown>
  if (variant === 'Player') {
    const addr = fields.addr as string | undefined
    if (!addr) return null
    return { type: 'player', address: addr }
  }
  if (variant === 'Ou') {
    const ouId = fields.dao_id as string | undefined
    if (!ouId) return null
    return { type: 'ou', ouId }
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
    // key is a plain string, the gRPC { "@variant": "Grant" } form, the raw
    // JSON-RPC { variant: "Grant", ... } form, or the normalized { Grant: {} }.
    const key = entry.key
    let roleVariant: string | undefined
    if (typeof key === 'string') {
      roleVariant = key
    } else if (key && typeof key === 'object') {
      const k = key as Record<string, unknown>
      roleVariant =
        (typeof k['@variant'] === 'string'
          ? (k['@variant'] as string)
          : undefined) ??
        (k.variant as string | undefined) ??
        (['Grant', 'Read', 'Write'] as const).find((v) => v in k)
    }
    if (roleVariant === 'Grant') grantPrincipals = principals
    else if (roleVariant === 'Read') readPrincipals = principals
    else if (roleVariant === 'Write') writePrincipals = principals
  }

  return { grantPrincipals, readPrincipals, writePrincipals }
}

// ── v2 principal ACL (dynamic field) ──────────────────────────────────────────
//
// v3+ deployments hold the upgradeable principal set in a dynamic field on the
// Keyspace: PrincipalAclKey → sui::versioned::Versioned → PrincipalAclV1
// { acl: VecMap<Role, vector<PrincipalV2>> }. Resolving it takes three hops:
// list the keyspace's dynamic fields, read the Versioned wrapper, read its
// versioned payload.
//
// This fetch DEGRADES, never throws. A pre-v3 contract, a keyspace with no v2
// grants, a payload schema version this SDK predates, or any RPC/shape error
// all yield empty sets — the SDK then behaves exactly as it did before v2
// existed. Within a known payload version, an unrecognized principal *kind* is
// dropped the same way, matching the contract's own fail-closed `satisfies_v2`.
// Upgrading the SDK is what reveals newer versions and kinds.

const PRINCIPAL_ACL_KEY_SUFFIX = '::principal_acl::PrincipalAclKey'
const KNOWN_PRINCIPAL_ACL_VERSIONS = [1]

interface PrincipalRoleMap {
  grant: Principal[]
  read: Principal[]
  write: Principal[]
}

const EMPTY_PRINCIPAL_ROLE_MAP: PrincipalRoleMap = {
  grant: [],
  read: [],
  write: [],
}

/** Parse one on-chain PrincipalV2 struct; null for kinds this SDK predates. */
function parsePrincipalV2(raw: unknown): Principal | null {
  if (!raw || typeof raw !== 'object') return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = ((raw as any)?.fields ?? raw) as Record<string, unknown>
  const kind = Number(p.kind ?? NaN)
  const id = p.id
  if (!Number.isFinite(kind) || typeof id !== 'string') return null
  return principalFromV2(kind, id)
}

function parseRoleKeyVariant(key: unknown): string | undefined {
  if (typeof key === 'string') return key
  if (key && typeof key === 'object') {
    const k = key as Record<string, unknown>
    return (
      (typeof k['@variant'] === 'string'
        ? (k['@variant'] as string)
        : undefined) ??
      (k.variant as string | undefined) ??
      (['Grant', 'Read', 'Write'] as const).find((v) => v in k)
    )
  }
  return undefined
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function listDynamicFields(
  suiClient: any,
  parentId: string,
): Promise<any[]> {
  const res = await suiClient.core.getDynamicFields({ parentId })
  return res?.dynamicFields ?? res?.data ?? []
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchFieldJson(
  suiClient: any,
  fieldObjectId: string,
): Promise<any> {
  const res = await suiClient.core.getObject({
    objectId: fieldObjectId,
    include: { json: true },
  })
  return res?.object?.json ?? null
}

/**
 * Fetch the v2 principal ACL for a keyspace, keyed by role. Returns empty sets
 * on any failure or absence — see the module note above.
 */
export async function fetchPrincipalRoleMapV2(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  suiClient: any,
  keyspaceId: string,
): Promise<PrincipalRoleMap> {
  try {
    // Hop 1: find the PrincipalAclKey field among the keyspace's dynamic
    // fields. Matched by type suffix so the (upgrade-specific) defining
    // package id never needs to be known to the reader.
    const fields = await listDynamicFields(suiClient, keyspaceId)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aclField = fields.find((f: any) => {
      const nameType = f?.name?.type ?? f?.type
      return (
        typeof nameType === 'string' &&
        nameType.endsWith(PRINCIPAL_ACL_KEY_SUFFIX)
      )
    })
    if (!aclField) return EMPTY_PRINCIPAL_ROLE_MAP
    const fieldId = aclField.fieldId ?? aclField.id ?? aclField.objectId
    if (!fieldId) return EMPTY_PRINCIPAL_ROLE_MAP

    // Hop 2: the field's value is a Versioned wrapper { id, version }.
    const fieldJson = await fetchFieldJson(suiClient, fieldId)
    const versioned = fieldJson?.value ?? fieldJson
    const versionedId = versioned?.id?.id ?? versioned?.id
    const version = Number(versioned?.version ?? NaN)
    if (!versionedId || !KNOWN_PRINCIPAL_ACL_VERSIONS.includes(version)) {
      return EMPTY_PRINCIPAL_ROLE_MAP
    }

    // Hop 3: the Versioned payload is itself a dynamic field keyed by version.
    const payloadFields = await listDynamicFields(suiClient, versionedId)
    const payloadField = payloadFields[0]
    const payloadId =
      payloadField?.fieldId ?? payloadField?.id ?? payloadField?.objectId
    if (!payloadId) return EMPTY_PRINCIPAL_ROLE_MAP
    const payloadJson = await fetchFieldJson(suiClient, payloadId)
    const payload = payloadJson?.value ?? payloadJson

    // PrincipalAclV1: { acl: VecMap<Role, vector<PrincipalV2>> } — role keys
    // arrive in the same three wire formats as the v1 ACL's.
    const contents = unwrapAcl(payload?.acl)
    const result: PrincipalRoleMap = { grant: [], read: [], write: [] }
    for (const rawEntry of contents) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entry = ((rawEntry as any)?.fields ?? rawEntry) as {
        key?: unknown
        value?: unknown
      }
      const principals = (
        Array.isArray(entry.value) ? entry.value : []
      ).flatMap((p) => {
        const parsed = parsePrincipalV2(p)
        return parsed ? [parsed] : []
      })
      const roleVariant = parseRoleKeyVariant(entry.key)
      if (roleVariant === 'Grant') result.grant = principals
      else if (roleVariant === 'Read') result.read = principals
      else if (roleVariant === 'Write') result.write = principals
    }
    return result
  } catch {
    return EMPTY_PRINCIPAL_ROLE_MAP
  }
}

// ── Queries ───────────────────────────────────────────────────────────────────

export async function fetchKeyspaceMeta(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  suiClient: any,
  keyspaceId: string,
): Promise<AclMeta | null> {
  // core.getObject throws if the object doesn't exist — treat as "not found".
  const res = await suiClient.core
    .getObject({ objectId: keyspaceId, include: { json: true } })
    .catch(() => null)
  if (res === null) return null
  const fields = res.object?.json as RawKeyspaceFields | null
  if (!fields) return null
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
  // core.getObject throws if the object doesn't exist — treat as "not found".
  const res = await suiClient.core
    .getObject({ objectId: keyspaceId, include: { json: true } })
    .catch(() => null)
  if (res === null) return null
  const fields = res.object?.json as RawKeyspaceFields | null
  if (!fields) return null

  const epoch = Number(fields.version ?? 0)
  const entryIds: string[] = fields.entries ?? []
  const aclContents = unwrapAcl(fields.acl)

  const { grantPrincipals, readPrincipals, writePrincipals } =
    parseRoleMap(aclContents)

  const [entries, v2] = await Promise.all([
    fetchEncryptedEntries(suiClient, entryIds, epoch),
    fetchPrincipalRoleMapV2(suiClient, keyspaceId),
  ])

  // Both ACL stores are live at once on-chain (satisfies_role reads both), so
  // a role's effective principal set is the union — consumers see one list and
  // never need to know which store a principal came from.
  const mergedGrant = [...grantPrincipals, ...v2.grant]
  const mergedRead = [...readPrincipals, ...v2.read]
  const mergedWrite = [...writePrincipals, ...v2.write]

  return {
    id: keyspaceId,
    name: fields.name,
    epoch,
    entryCount: entryIds.length,
    grantPrincipals: mergedGrant,
    readPrincipals: mergedRead,
    writePrincipals: mergedWrite,
    roles: mergedRead, // backwards-compat alias
    entries,
  }
}

export async function fetchEncryptedEntry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  suiClient: any,
  entryId: string,
  keyspaceEpoch: number,
): Promise<EntryMeta | null> {
  // core.getObject throws if the object doesn't exist — treat as "not found".
  const res = await suiClient.core
    .getObject({ objectId: entryId, include: { json: true } })
    .catch(() => null)
  if (res === null) return null
  const fields = res.object?.json as RawEncryptedEntryFields | null
  if (!fields) return null
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
  const res = await suiClient.core.getObjects({
    objectIds: entryIds,
    include: { json: true },
  })

  // core.getObjects returns `{ objects: (Object | Error)[] }`; Error entries
  // (e.g. deleted/out-of-retention) and objects without Move JSON are skipped.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((res?.objects ?? []) as any[]).flatMap((obj: any) => {
    const fields = obj?.json as RawEncryptedEntryFields | null
    if (!fields) return []
    const entryEpoch = Number(fields.epoch ?? 0)
    return [
      {
        id: obj.objectId as string,
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
  apiKey: string,
): Promise<string[]> {
  const res = await fetch(`${indexerUrl}/v1/address/${address}/keyspaces`, {
    headers: { 'x-api-key': apiKey },
  })
  if (!res.ok) {
    throw new AclClientError(
      AclError.UnexpectedResponse,
      `Indexer error (${res.status}): ${res.statusText}`,
    )
  }
  const { keyspaceIds } = (await res.json()) as { keyspaceIds: string[] }
  return keyspaceIds
}
