import type { AdminCap, AclDetail, AclMeta, EntryMeta, Role } from './types'
import { AclClientError, AclError } from './errors'

// ── Raw field shapes returned by Sui RPC ──────────────────────────────────────

interface RawAdminCapFields {
  allowlist_id: string
}

interface RawAllowListFields {
  owner: string
  name: string
  list: { fields: { contents: string[] } }
  version: string | number
  entries: string[]
}

interface RawEncryptedEntryFields {
  allowlist_id: string
  location: string
  description: string
  created_by: string
  epoch: string | number
}

// ── Queries ───────────────────────────────────────────────────────────────────

export async function fetchAdminCaps(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  suiClient: any,
  packageId: string,
  address: string,
): Promise<AdminCap[]> {
  const res = await suiClient.getOwnedObjects({
    owner: address,
    filter: { StructType: `${packageId}::acl_encrypt::AdminCap` },
    options: { showContent: true },
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (res.data ?? []).flatMap((obj: any) => {
    const content = obj.data?.content
    if (content?.dataType !== 'moveObject') return []
    const fields = content.fields as RawAdminCapFields
    return [{ id: obj.data.objectId as string, aclId: fields.allowlist_id }]
  })
}

export async function fetchAllowListMeta(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  suiClient: any,
  allowlistId: string,
): Promise<AclMeta | null> {
  const res = await suiClient.getObject({
    id: allowlistId,
    options: { showContent: true },
  })
  const content = res.data?.content
  if (content?.dataType !== 'moveObject') return null
  const fields = content.fields as RawAllowListFields
  return {
    id: allowlistId,
    owner: fields.owner,
    name: fields.name,
    epoch: Number(fields.version ?? 0),
    entryCount: (fields.entries ?? []).length,
  }
}

export async function fetchAllowListDetail(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  suiClient: any,
  packageId: string,
  allowlistId: string,
): Promise<AclDetail | null> {
  const res = await suiClient.getObject({
    id: allowlistId,
    options: { showContent: true },
  })
  const content = res.data?.content
  if (content?.dataType !== 'moveObject') return null
  const fields = content.fields as RawAllowListFields

  const epoch = Number(fields.version ?? 0)
  const memberAddresses: string[] = fields.list?.fields?.contents ?? []
  const entryIds: string[] = fields.entries ?? []

  const roles: Role[] = memberAddresses.map((addr) => ({
    type: 'address',
    address: addr,
  }))
  const entries = await fetchEncryptedEntries(
    suiClient,
    packageId,
    entryIds,
    epoch,
  )

  return {
    id: allowlistId,
    owner: fields.owner,
    name: fields.name,
    epoch,
    entryCount: entryIds.length,
    roles,
    entries,
  }
}

export async function fetchEncryptedEntry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  suiClient: any,
  entryId: string,
  aclEpoch: number,
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
    aclId: fields.allowlist_id,
    location: fields.location,
    description: fields.description,
    createdBy: fields.created_by,
    epoch: entryEpoch,
    isStale: entryEpoch < aclEpoch,
  }
}

async function fetchEncryptedEntries(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  suiClient: any,
  _packageId: string,
  entryIds: string[],
  aclEpoch: number,
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
        aclId: fields.allowlist_id,
        location: fields.location,
        description: fields.description,
        createdBy: fields.created_by,
        epoch: entryEpoch,
        isStale: entryEpoch < aclEpoch,
      } satisfies EntryMeta,
    ]
  })
}

export async function fetchAccessibleAcls(
  indexerUrl: string,
  address: string,
): Promise<string[]> {
  const res = await fetch(`${indexerUrl}/v1/address/${address}/acls`)
  if (!res.ok) {
    throw new AclClientError(
      AclError.UnexpectedResponse,
      `Indexer error (${res.status}): ${res.statusText}`,
    )
  }
  const { aclIds } = (await res.json()) as { aclIds: string[] }
  return aclIds
}
