import { jest } from '@jest/globals'
import {
  fetchKeyspaceMeta,
  fetchKeyspaceDetail,
  fetchEncryptedEntry,
  fetchAccessibleKeyspaces,
} from '../src/queries'
import { AclError, AclClientError } from '../src/errors'

// ── Helpers ───────────────────────────────────────────────────────────────────

const ACL_ID = '0xacl001'
const ENTRY_ID = '0xentry01'
const OWNER = '0xowner'
const MEMBER1 =
  '0x0000000000000000000000000000000000000000000000000000000000001001'
const MEMBER2 =
  '0x0000000000000000000000000000000000000000000000000000000000001002'
const OU_ID =
  '0x0000000000000000000000000000000000000000000000000000000000002001'

// The queries use the unified core API (`client.core.getObject` /
// `client.core.getObjects`). Override keys stay `getObject`/`multiGetObjects`
// for readability but are wired onto `core`.
function makeSuiClient(overrides: Record<string, jest.Mock> = {}) {
  return {
    core: {
      getObject: overrides.getObject ?? (jest.fn() as jest.Mock),
      getObjects:
        overrides.getObjects ??
        overrides.multiGetObjects ??
        (jest.fn() as jest.Mock),
      // Machine-ACL lookups degrade to empty on any failure, so tests that
      // don't care about machines get a rejecting default and still pass.
      getDynamicFields:
        overrides.getDynamicFields ??
        ((jest.fn() as any).mockRejectedValue(
          new Error('no dynamic fields in this mock'),
        ) as jest.Mock),
    },
  }
}

// core.getObject returns `{ object: { objectId, json } }`, where `json` is the
// object's Move struct rendered as JSON (null for non-Move objects).
function moveObjectResponse(id: string, fields: Record<string, unknown>) {
  return { object: { objectId: id, json: fields } }
}

function makeKeyspaceFields(overrides: Record<string, unknown> = {}) {
  return {
    name: 'My Keyspace',
    version: 1,
    entries: [],
    acl: { contents: [] },
    ...overrides,
  }
}

// ── fetchKeyspaceMeta ─────────────────────────────────────────────────────────

describe('fetchKeyspaceMeta', () => {
  it('returns null when content is not moveObject', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue({
        object: { json: null },
      }),
    })
    const result = await fetchKeyspaceMeta(client, ACL_ID)
    expect(result).toBeNull()
  })

  it('returns AclMeta for a valid keyspace object', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(
          ACL_ID,
          makeKeyspaceFields({
            name: 'My Keyspace',
            version: 3,
            entries: ['e1', 'e2'],
          }),
        ),
      ),
    })
    const result = await fetchKeyspaceMeta(client, ACL_ID)
    expect(result).toEqual({
      id: ACL_ID,
      name: 'My Keyspace',
      epoch: 3,
      entryCount: 2,
    })
  })

  it('defaults epoch to 0 when version is missing', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(ACL_ID, {
          name: 'My Keyspace',
          entries: [],
          acl: { contents: [] },
        }),
      ),
    })
    const result = await fetchKeyspaceMeta(client, ACL_ID)
    expect(result?.epoch).toBe(0)
  })

  it('returns null when getObject rejects (object not found)', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockRejectedValue(new Error('not found')),
    })
    const result = await fetchKeyspaceMeta(client, ACL_ID)
    expect(result).toBeNull()
  })
})

// ── fetchKeyspaceDetail ───────────────────────────────────────────────────────

describe('fetchKeyspaceDetail', () => {
  it('returns null when content is not moveObject', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue({
        object: { json: null },
      }),
      multiGetObjects: (jest.fn() as any).mockResolvedValue({ objects: [] }),
    })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    expect(result).toBeNull()
  })

  it('returns AclDetail with empty principals when acl is empty', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(
          ACL_ID,
          makeKeyspaceFields({
            name: 'Shared ACL',
            version: 2,
            acl: { contents: [] },
          }),
        ),
      ),
      multiGetObjects: (jest.fn() as any).mockResolvedValue({ objects: [] }),
    })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    expect(result).not.toBeNull()
    expect(result!.id).toBe(ACL_ID)
    expect(result!.name).toBe('Shared ACL')
    expect(result!.epoch).toBe(2)
    expect(result!.grantPrincipals).toEqual([])
    expect(result!.readPrincipals).toEqual([])
    expect(result!.writePrincipals).toEqual([])
    expect(result!.entries).toEqual([])
  })

  it('parses Player principals from acl.contents', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(
          ACL_ID,
          makeKeyspaceFields({
            version: 1,
            acl: {
              contents: [
                {
                  key: 'Read',
                  value: [
                    { Player: { addr: MEMBER1 } },
                    { Player: { addr: MEMBER2 } },
                  ],
                },
              ],
            },
          }),
        ),
      ),
      multiGetObjects: (jest.fn() as any).mockResolvedValue({ objects: [] }),
    })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    expect(result!.readPrincipals).toEqual([
      { type: 'player', address: MEMBER1 },
      { type: 'player', address: MEMBER2 },
    ])
    expect(result!.roles).toEqual(result!.readPrincipals)
  })

  it('ignores unrecognised principal shapes in acl.contents', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(
          ACL_ID,
          makeKeyspaceFields({
            acl: {
              contents: [
                {
                  key: 'Read',
                  value: [
                    { UnknownVariant: {} },
                    null,
                    42,
                    { Player: { addr: MEMBER1 } },
                  ],
                },
              ],
            },
          }),
        ),
      ),
      multiGetObjects: (jest.fn() as any).mockResolvedValue({ objects: [] }),
    })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    // Only the valid Player entry survives; unknown shapes are silently dropped
    expect(result!.readPrincipals).toEqual([
      { type: 'player', address: MEMBER1 },
    ])
  })

  it('parses Write principals from acl.contents', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(
          ACL_ID,
          makeKeyspaceFields({
            acl: {
              contents: [
                { key: 'Write', value: [{ Player: { addr: MEMBER1 } }] },
              ],
            },
          }),
        ),
      ),
      multiGetObjects: (jest.fn() as any).mockResolvedValue({ objects: [] }),
    })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    expect(result!.writePrincipals).toEqual([
      { type: 'player', address: MEMBER1 },
    ])
    expect(result!.readPrincipals).toEqual([])
    expect(result!.grantPrincipals).toEqual([])
  })

  it('parses Ou principals from acl.contents', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(
          ACL_ID,
          makeKeyspaceFields({
            version: 1,
            acl: {
              contents: [{ key: 'Grant', value: [{ Ou: { dao_id: OU_ID } }] }],
            },
          }),
        ),
      ),
      multiGetObjects: (jest.fn() as any).mockResolvedValue({ objects: [] }),
    })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    expect(result!.grantPrincipals).toEqual([{ type: 'ou', ouId: OU_ID }])
  })

  it('parses gRPC @variant Player and Ou principals', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(
          ACL_ID,
          makeKeyspaceFields({
            acl: {
              contents: [
                {
                  key: 'Read',
                  value: [{ '@variant': 'Player', addr: MEMBER1 }],
                },
                {
                  key: 'Grant',
                  value: [{ '@variant': 'Ou', dao_id: OU_ID }],
                },
              ],
            },
          }),
        ),
      ),
      multiGetObjects: (jest.fn() as any).mockResolvedValue({ objects: [] }),
    })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    expect(result!.readPrincipals).toEqual([
      { type: 'player', address: MEMBER1 },
    ])
    expect(result!.grantPrincipals).toEqual([{ type: 'ou', ouId: OU_ID }])
  })

  it('parses raw JSON-RPC { variant, fields } Player and Ou principals', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(
          ACL_ID,
          makeKeyspaceFields({
            acl: {
              contents: [
                {
                  key: 'Read',
                  value: [{ variant: 'Player', fields: { addr: MEMBER1 } }],
                },
                {
                  key: 'Grant',
                  value: [{ variant: 'Ou', fields: { dao_id: OU_ID } }],
                },
              ],
            },
          }),
        ),
      ),
      multiGetObjects: (jest.fn() as any).mockResolvedValue({ objects: [] }),
    })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    expect(result!.readPrincipals).toEqual([
      { type: 'player', address: MEMBER1 },
    ])
    expect(result!.grantPrincipals).toEqual([{ type: 'ou', ouId: OU_ID }])
  })

  // ── v2 principal ACL (dynamic field) ────────────────────────────────────────

  const FIELD_ID = '0xprincipalaclfield'
  const VERSIONED_ID = '0xversioned01'
  const PAYLOAD_ID = '0xpayload01'

  function v2AclClient(opts: { version?: number; readValue?: unknown[] }) {
    const version = opts.version ?? 1
    const readValue = opts.readValue ?? [{ kind: 2, id: MEMBER2, data: [] }]
    return makeSuiClient({
      getObject: (jest.fn() as any).mockImplementation(
        async ({ objectId }: { objectId: string }) => {
          if (objectId === ACL_ID) {
            return moveObjectResponse(
              ACL_ID,
              makeKeyspaceFields({
                acl: {
                  contents: [
                    { key: 'Read', value: [{ Player: { addr: MEMBER1 } }] },
                  ],
                },
              }),
            )
          }
          if (objectId === FIELD_ID) {
            return moveObjectResponse(FIELD_ID, {
              name: {},
              value: { id: VERSIONED_ID, version },
            })
          }
          if (objectId === PAYLOAD_ID) {
            return moveObjectResponse(PAYLOAD_ID, {
              name: version,
              value: { acl: { contents: [{ key: 'Read', value: readValue }] } },
            })
          }
          throw new Error(`unexpected object fetch: ${objectId}`)
        },
      ),
      multiGetObjects: (jest.fn() as any).mockResolvedValue({ objects: [] }),
      getDynamicFields: (jest.fn() as any).mockImplementation(
        async ({ parentId }: { parentId: string }) => {
          if (parentId === ACL_ID) {
            return {
              dynamicFields: [
                {
                  fieldId: FIELD_ID,
                  name: { type: '0xpkg::keyspace::PrincipalAclKey' },
                },
              ],
            }
          }
          if (parentId === VERSIONED_ID) {
            return {
              dynamicFields: [{ fieldId: PAYLOAD_ID, name: { type: 'u64' } }],
            }
          }
          return { dynamicFields: [] }
        },
      ),
    })
  }

  it('merges v2 principals into the role sets, union with the v1 store', async () => {
    const client = v2AclClient({})
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    expect(result!.readPrincipals).toEqual([
      { type: 'player', address: MEMBER1 },
      { type: 'machine', address: MEMBER2 },
    ])
    expect(result!.roles).toEqual(result!.readPrincipals)
  })

  it('maps every known v2 kind back to its principal type', async () => {
    const client = v2AclClient({
      readValue: [
        { kind: 0, id: MEMBER2, data: [] },
        { kind: 1, id: OU_ID, data: [] },
        { kind: 2, id: MEMBER2, data: [] },
      ],
    })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    expect(result!.readPrincipals).toEqual([
      { type: 'player', address: MEMBER1 },
      { type: 'player', address: MEMBER2 },
      { type: 'ou', ouId: OU_ID },
      { type: 'machine', address: MEMBER2 },
    ])
  })

  it('drops v2 principals of a kind this SDK predates, keeping the rest', async () => {
    const client = v2AclClient({
      readValue: [
        { kind: 2, id: MEMBER2, data: [] },
        { kind: 200, id: MEMBER1, data: [] }, // future kind
      ],
    })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    expect(result!.readPrincipals).toEqual([
      { type: 'player', address: MEMBER1 },
      { type: 'machine', address: MEMBER2 },
    ])
  })

  it('degrades to no v2 principals when the stored schema version is unknown', async () => {
    const client = v2AclClient({ version: 2 })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    expect(result!.readPrincipals).toEqual([
      { type: 'player', address: MEMBER1 },
    ])
  })

  it('degrades to no v2 principals when the keyspace has no v2 ACL field', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(
          ACL_ID,
          makeKeyspaceFields({
            acl: {
              contents: [
                { key: 'Read', value: [{ Player: { addr: MEMBER1 } }] },
              ],
            },
          }),
        ),
      ),
      multiGetObjects: (jest.fn() as any).mockResolvedValue({ objects: [] }),
      getDynamicFields: (jest.fn() as any).mockResolvedValue({
        dynamicFields: [],
      }),
    })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    expect(result!.readPrincipals).toEqual([
      { type: 'player', address: MEMBER1 },
    ])
  })

  it('degrades to no v2 principals when dynamic-field lookups fail entirely', async () => {
    // makeSuiClient's default getDynamicFields rejects — the pre-v3 world.
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(
          ACL_ID,
          makeKeyspaceFields({
            acl: {
              contents: [
                { key: 'Read', value: [{ Player: { addr: MEMBER1 } }] },
              ],
            },
          }),
        ),
      ),
      multiGetObjects: (jest.fn() as any).mockResolvedValue({ objects: [] }),
    })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    expect(result!.readPrincipals).toEqual([
      { type: 'player', address: MEMBER1 },
    ])
  })

  it('drops @variant / variant principals that are missing their address fields', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(
          ACL_ID,
          makeKeyspaceFields({
            acl: {
              contents: [
                {
                  key: 'Read',
                  value: [
                    { '@variant': 'Player' }, // no addr
                    { '@variant': 'Ou' }, // no dao_id
                    { variant: 'Player', fields: {} }, // no addr
                    { variant: 'Ou', fields: {} }, // no dao_id
                    { variant: 'Bogus', fields: {} }, // unknown variant
                  ],
                },
              ],
            },
          }),
        ),
      ),
      multiGetObjects: (jest.fn() as any).mockResolvedValue({ objects: [] }),
    })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    expect(result!.readPrincipals).toEqual([])
  })

  it('parses role keys given as gRPC, raw, normalized, and wrapped objects', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(
          ACL_ID,
          makeKeyspaceFields({
            acl: {
              contents: [
                // gRPC { "@variant": "Read" } key
                {
                  key: { '@variant': 'Read' },
                  value: [{ Player: { addr: MEMBER1 } }],
                },
                // raw JSON-RPC { variant: "Write" } key
                {
                  key: { variant: 'Write' },
                  value: [{ Player: { addr: MEMBER2 } }],
                },
                // normalized { Grant: {} } key, wrapped in { fields: { key, value } }
                {
                  fields: {
                    key: { Grant: {} },
                    value: [{ Ou: { dao_id: OU_ID } }],
                  },
                },
              ],
            },
          }),
        ),
      ),
      multiGetObjects: (jest.fn() as any).mockResolvedValue({ objects: [] }),
    })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    expect(result!.readPrincipals).toEqual([
      { type: 'player', address: MEMBER1 },
    ])
    expect(result!.writePrincipals).toEqual([
      { type: 'player', address: MEMBER2 },
    ])
    expect(result!.grantPrincipals).toEqual([{ type: 'ou', ouId: OU_ID }])
  })

  it('unwraps acl from the JSON-RPC { fields: { contents } } shape', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(
          ACL_ID,
          makeKeyspaceFields({
            acl: {
              fields: {
                contents: [
                  { key: 'Read', value: [{ Player: { addr: MEMBER1 } }] },
                ],
              },
            },
          }),
        ),
      ),
      multiGetObjects: (jest.fn() as any).mockResolvedValue({ objects: [] }),
    })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    expect(result!.readPrincipals).toEqual([
      { type: 'player', address: MEMBER1 },
    ])
  })

  it('returns null when getObject rejects (object not found)', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockRejectedValue(new Error('not found')),
      multiGetObjects: (jest.fn() as any).mockResolvedValue({ objects: [] }),
    })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    expect(result).toBeNull()
  })

  it('includes fetched entries in the detail', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(
          ACL_ID,
          makeKeyspaceFields({
            version: 5,
            entries: [ENTRY_ID],
          }),
        ),
      ),
      multiGetObjects: (jest.fn() as any).mockResolvedValue({
        objects: [
          {
            objectId: ENTRY_ID,
            json: {
              keyspace_id: ACL_ID,
              uri: 'ipfs://QmABC',
              description: 'test entry',
              created_by: OWNER,
              epoch: 5,
            },
          },
        ],
      }),
    })
    const result = await fetchKeyspaceDetail(client, ACL_ID)
    expect(result!.entries).toHaveLength(1)
    expect(result!.entries[0]).toMatchObject({
      id: ENTRY_ID,
      keyspaceId: ACL_ID,
      uri: 'ipfs://QmABC',
      description: 'test entry',
      epoch: 5,
      isStale: false,
    })
  })
})

// ── fetchEncryptedEntry ───────────────────────────────────────────────────────

describe('fetchEncryptedEntry', () => {
  it('returns null when content is not moveObject', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue({
        object: { json: null },
      }),
    })
    const result = await fetchEncryptedEntry(client, ENTRY_ID, 1)
    expect(result).toBeNull()
  })

  it('returns null when getObject rejects (object not found)', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockRejectedValue(new Error('not found')),
    })
    const result = await fetchEncryptedEntry(client, ENTRY_ID, 1)
    expect(result).toBeNull()
  })

  it('marks entry as not stale when entry epoch equals keyspace epoch', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(ENTRY_ID, {
          keyspace_id: ACL_ID,
          uri: 'ipfs://QmXYZ',
          description: 'data',
          created_by: OWNER,
          epoch: 3,
        }),
      ),
    })
    const result = await fetchEncryptedEntry(client, ENTRY_ID, 3)
    expect(result!.isStale).toBe(false)
    expect(result!.epoch).toBe(3)
  })

  it('marks entry as stale when entry epoch is less than keyspace epoch', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(ENTRY_ID, {
          keyspace_id: ACL_ID,
          uri: 'ipfs://QmXYZ',
          description: 'data',
          created_by: OWNER,
          epoch: 1,
        }),
      ),
    })
    const result = await fetchEncryptedEntry(client, ENTRY_ID, 3)
    expect(result!.isStale).toBe(true)
  })

  it('returns full EntryMeta fields', async () => {
    const client = makeSuiClient({
      getObject: (jest.fn() as any).mockResolvedValue(
        moveObjectResponse(ENTRY_ID, {
          keyspace_id: ACL_ID,
          uri: 'ipfs://QmFULL',
          description: 'full entry',
          created_by: OWNER,
          epoch: '2',
        }),
      ),
    })
    const result = await fetchEncryptedEntry(client, ENTRY_ID, 2)
    expect(result).toEqual({
      id: ENTRY_ID,
      keyspaceId: ACL_ID,
      uri: 'ipfs://QmFULL',
      description: 'full entry',
      createdBy: OWNER,
      epoch: 2,
      isStale: false,
    })
  })
})

// ── fetchAccessibleKeyspaces ──────────────────────────────────────────────────

describe('fetchAccessibleKeyspaces', () => {
  const INDEXER = 'https://indexer.example.com'

  let fetchMock: any

  beforeEach(() => {
    fetchMock = jest.fn()
    ;(global as any).fetch = fetchMock
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('returns keyspaceIds from the indexer and sends the api key as the x-api-key header', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ keyspaceIds: ['0xacl1', '0xacl2'] }),
    })
    const result = await fetchAccessibleKeyspaces(INDEXER, OWNER, 'sk-test-key')
    expect(result).toEqual(['0xacl1', '0xacl2'])
    expect(fetchMock).toHaveBeenCalledWith(
      `${INDEXER}/v1/address/${OWNER}/keyspaces`,
      { headers: { 'x-api-key': 'sk-test-key' } },
    )
  })

  it('throws AclClientError(UnexpectedResponse) on non-ok response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    })
    await expect(
      fetchAccessibleKeyspaces(INDEXER, OWNER, 'sk-test-key'),
    ).rejects.toThrow(AclClientError)
    await expect(
      fetchAccessibleKeyspaces(INDEXER, OWNER, 'sk-test-key'),
    ).rejects.toMatchObject({
      code: AclError.UnexpectedResponse,
    })
  })
})
