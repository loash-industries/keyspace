/**
 * End-to-end: a locations list that fell behind the keyspace epoch is brought
 * back up to date by the very write that adds a location to it.
 *
 * Everything inside the SDK is real — `LocationsClient`, `AclClient`, the
 * on-chain query parsers in `queries.ts`, and the PTB builders in
 * `transactions.ts`. The two things outside the SDK are faked:
 *
 *   • Sui: an in-memory chain that serves `core.getObject`/`getObjects` in the
 *     gRPC core-json shape the parsers expect, and an `executor` that walks the
 *     built PTB command-by-command and applies `armature_vault::keyspace`'s
 *     rules — Read grants/revokes bump `version`, `publish_entry` stamps the
 *     entry with the current version, `update_entry` aborts on a current entry
 *     (EAlreadyCurrentEpoch) and otherwise sets `epoch = version`, and
 *     `edit_entry` only changes the uri. Write/Grant role checks are enforced.
 *   • Seal: `seal_helpers` is mocked with a transparent envelope whose
 *     `sealDecrypt` enforces the keyspace's *current* Read set, which is what
 *     `keyspace::seal_approve` does on the real key servers.
 *
 * Storage is an in-memory adapter. No network is touched.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import { bcs } from '@mysten/sui/bcs'
import { fromBase64 } from '@mysten/sui/utils'
import type { Transaction } from '@mysten/sui/transactions'
import type { Principal, StorageAdapter } from '../src/types'
import { AclClientError, AclError } from '../src/errors'

// ── Constants ─────────────────────────────────────────────────────────────────

const PKG = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
const OU_ID =
  '0x0000000000000000000000000000000000000000000000000000000000000ab1'
const WRITER =
  '0x0000000000000000000000000000000000000000000000000000000000000a01'
const READER =
  '0x0000000000000000000000000000000000000000000000000000000000000a02'
const OTHER_READER =
  '0x0000000000000000000000000000000000000000000000000000000000000a03'
const WRITE_ONLY =
  '0x0000000000000000000000000000000000000000000000000000000000000a04'

const SIGN = (jest.fn() as any).mockResolvedValue('sig')

// ── Fake chain ────────────────────────────────────────────────────────────────

type Role = 'Grant' | 'Read' | 'Write'

interface FakeKeyspace {
  id: string
  name: string
  version: number
  entries: string[]
  acl: Record<Role, Principal[]>
}

interface FakeEntry {
  id: string
  keyspace_id: string
  uri: string
  description: string
  created_by: string
  epoch: number
}

/** Mirrors the Move abort codes in armature_vault::keyspace. */
const ABORT = {
  ENotAllowed: 0,
  EAlreadyGranted: 1,
  ENotGranted: 2,
  EAlreadyCurrentEpoch: 3,
  EWrongKeyspace: 4,
} as const

class MoveAbort extends Error {
  constructor(
    readonly fn: string,
    readonly code: number,
  ) {
    super(`MoveAbort in keyspace::${fn}, code ${code}`)
  }
}

const sameAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

function samePrincipal(a: Principal, b: Principal): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'ou' && b.type === 'ou') return sameAddr(a.ouId, b.ouId)
  if (a.type !== 'ou' && b.type !== 'ou') return sameAddr(a.address, b.address)
  return false
}

/** gRPC core-json rendering of a Principal, as `queries.ts` parses it. */
function principalJson(p: Principal): Record<string, unknown> {
  if (p.type === 'ou') return { '@variant': 'Ou', ou_id: p.ouId }
  return {
    '@variant': p.type === 'player' ? 'Player' : 'Machine',
    addr: p.address,
  }
}

class FakeChain {
  readonly keyspaces = new Map<string, FakeKeyspace>()
  readonly entries = new Map<string, FakeEntry>()
  /** `module::function` of every Move call executed, in order. */
  readonly moveCalls: string[] = []
  /** One element per executed transaction: the Move calls it contained. */
  readonly transactions: string[][] = []
  private nextId = 0x1000

  // The blobs: uri → ciphertext. Doubles as the SDK's StorageAdapter.
  readonly blobs = new Map<string, Uint8Array>()
  readonly storage: StorageAdapter & { uploads: number } = {
    uploads: 0,
    upload: async (data: Uint8Array) => {
      this.storage.uploads++
      const uri = `mem://blob-${this.storage.uploads}`
      this.blobs.set(uri, data)
      return uri
    },
    download: async (uri: string) => {
      const hit = this.blobs.get(uri)
      if (!hit) throw new Error(`no blob at ${uri}`)
      return hit
    },
  }

  /** Stand-in for `SuiClient` — only the `core` surface the SDK touches. */
  readonly suiClient = {
    core: {
      getObject: async ({ objectId }: { objectId: string }) => {
        const json = this.objectJson(objectId)
        if (!json) throw new Error(`object not found: ${objectId}`)
        return { object: { objectId, json } }
      },
      getObjects: async ({ objectIds }: { objectIds: string[] }) => ({
        objects: objectIds.map((objectId) => {
          const json = this.objectJson(objectId)
          return json ? { objectId, json } : new Error('not found')
        }),
      }),
    },
  }

  private freshId(): string {
    return `0x${(this.nextId++).toString(16).padStart(64, '0')}`
  }

  private objectJson(objectId: string): Record<string, unknown> | null {
    const ks = this.keyspaces.get(objectId)
    if (ks) {
      return {
        name: ks.name,
        version: String(ks.version),
        entries: [...ks.entries],
        acl: {
          contents: (['Grant', 'Read', 'Write'] as Role[]).map((role) => ({
            key: { '@variant': role },
            value: ks.acl[role].map(principalJson),
          })),
        },
      }
    }
    const entry = this.entries.get(objectId)
    if (entry) {
      return {
        keyspace_id: entry.keyspace_id,
        uri: entry.uri,
        description: entry.description,
        created_by: entry.created_by,
        epoch: String(entry.epoch),
      }
    }
    return null
  }

  holdsRole(ks: FakeKeyspace, role: Role, sender: string): boolean {
    return ks.acl[role].some(
      (p) =>
        (p.type === 'player' || p.type === 'machine') &&
        sameAddr(p.address, sender),
    )
  }

  private keyspace(id: string): FakeKeyspace {
    const ks = this.keyspaces.get(id)
    if (!ks) throw new Error(`keyspace not found: ${id}`)
    return ks
  }

  private entry(id: string): FakeEntry {
    const e = this.entries.get(id)
    if (!e) throw new Error(`entry not found: ${id}`)
    return e
  }

  /**
   * A `TransactionExecutor` that "signs" as `sender`: walks the PTB and applies
   * each Move call against the in-memory state.
   */
  executor(sender: string) {
    return async (tx: Transaction) => {
      const { inputs, commands } = tx.getData()
      const results: unknown[] = []
      const objectChanges: {
        type: string
        objectId: string
        objectType: string
      }[] = []
      const calls: string[] = []

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resolve = (arg: any): unknown => {
        if (arg.$kind === 'Input') {
          const input = inputs[arg.Input]
          if (input.$kind === 'UnresolvedObject')
            return { object: input.UnresolvedObject.objectId }
          if (input.$kind === 'Pure')
            return { pure: fromBase64(input.Pure.bytes) }
          throw new Error(`unsupported input kind ${input.$kind}`)
        }
        if (arg.$kind === 'Result') return results[arg.Result]
        throw new Error(`unsupported argument kind ${arg.$kind}`)
      }
      const objectArg = (v: unknown) => (v as { object: string }).object
      const utf8Arg = (v: unknown) =>
        new TextDecoder().decode(
          Uint8Array.from(
            bcs.vector(bcs.u8()).parse((v as { pure: Uint8Array }).pure),
          ),
        )
      const addressArg = (v: unknown) =>
        bcs.Address.parse((v as { pure: Uint8Array }).pure)

      for (const cmd of commands) {
        if (cmd.$kind !== 'MoveCall')
          throw new Error(`unsupported command ${cmd.$kind}`)
        const {
          package: pkg,
          module,
          function: fn,
          arguments: rawArgs,
        } = cmd.MoveCall
        if (pkg !== PKG) throw new Error(`unexpected package ${pkg}`)
        const args = rawArgs.map(resolve)
        calls.push(`${module}::${fn}`)
        this.moveCalls.push(`${module}::${fn}`)

        switch (`${module}::${fn}`) {
          case 'keyspace::role_grant':
            results.push('Grant')
            break
          case 'keyspace::role_read':
            results.push('Read')
            break
          case 'keyspace::role_write':
            results.push('Write')
            break
          case 'acl::player':
            results.push({ type: 'player', address: addressArg(args[0]) })
            break
          case 'acl::machine':
            results.push({ type: 'machine', address: addressArg(args[0]) })
            break
          case 'acl::ou':
            results.push({ type: 'ou', ouId: addressArg(args[0]) })
            break

          case 'keyspace::create_keyspace': {
            const me: Principal = { type: 'player', address: sender }
            const id = this.freshId()
            this.keyspaces.set(id, {
              id,
              name: utf8Arg(args[0]),
              version: 1,
              entries: [],
              acl: { Grant: [me], Read: [me], Write: [me] },
            })
            objectChanges.push({
              type: 'created',
              objectId: id,
              objectType: `${PKG}::keyspace::Keyspace`,
            })
            results.push(undefined)
            break
          }

          case 'keyspace::grant': {
            const ks = this.keyspace(objectArg(args[0]))
            const role = args[1] as Role
            const principal = args[2] as Principal
            if (!this.holdsRole(ks, 'Grant', sender))
              throw new MoveAbort(fn, ABORT.ENotAllowed)
            if (ks.acl[role].some((p) => samePrincipal(p, principal)))
              throw new MoveAbort(fn, ABORT.EAlreadyGranted)
            ks.acl[role].push(principal)
            if (role === 'Read') ks.version += 1
            results.push(undefined)
            break
          }

          case 'keyspace::revoke': {
            const ks = this.keyspace(objectArg(args[0]))
            const role = args[1] as Role
            const principal = args[2] as Principal
            if (!this.holdsRole(ks, 'Grant', sender))
              throw new MoveAbort(fn, ABORT.ENotAllowed)
            const before = ks.acl[role].length
            ks.acl[role] = ks.acl[role].filter(
              (p) => !samePrincipal(p, principal),
            )
            if (ks.acl[role].length === before)
              throw new MoveAbort(fn, ABORT.ENotGranted)
            if (role === 'Read') ks.version += 1
            results.push(undefined)
            break
          }

          case 'keyspace::publish_entry': {
            const ks = this.keyspace(objectArg(args[0]))
            if (!this.holdsRole(ks, 'Write', sender))
              throw new MoveAbort(fn, ABORT.ENotAllowed)
            const id = this.freshId()
            this.entries.set(id, {
              id,
              keyspace_id: ks.id,
              uri: utf8Arg(args[1]),
              description: utf8Arg(args[2]),
              created_by: sender,
              epoch: ks.version,
            })
            ks.entries.push(id)
            objectChanges.push({
              type: 'created',
              objectId: id,
              objectType: `${PKG}::keyspace::EncryptedEntry`,
            })
            results.push(undefined)
            break
          }

          case 'keyspace::update_entry': {
            const ks = this.keyspace(objectArg(args[0]))
            const entry = this.entry(objectArg(args[1]))
            if (!this.holdsRole(ks, 'Write', sender))
              throw new MoveAbort(fn, ABORT.ENotAllowed)
            if (entry.keyspace_id !== ks.id)
              throw new MoveAbort(fn, ABORT.EWrongKeyspace)
            if (entry.epoch === ks.version)
              throw new MoveAbort(fn, ABORT.EAlreadyCurrentEpoch)
            entry.uri = utf8Arg(args[2])
            entry.epoch = ks.version
            results.push(undefined)
            break
          }

          case 'keyspace::edit_entry': {
            const ks = this.keyspace(objectArg(args[0]))
            const entry = this.entry(objectArg(args[1]))
            if (!this.holdsRole(ks, 'Write', sender))
              throw new MoveAbort(fn, ABORT.ENotAllowed)
            if (entry.keyspace_id !== ks.id)
              throw new MoveAbort(fn, ABORT.EWrongKeyspace)
            entry.uri = utf8Arg(args[2])
            results.push(undefined)
            break
          }

          default:
            throw new Error(`fake chain: unhandled call ${module}::${fn}`)
        }
      }

      this.transactions.push(calls)
      return { digest: `0xdigest${this.transactions.length}`, objectChanges }
    }
  }
}

// One chain per test; the Seal mock below reaches it through this binding.
let chain: FakeChain

// ── Fake Seal ─────────────────────────────────────────────────────────────────
//
// Envelope: a 4-byte marker, a 4-byte write counter (stands in for the fresh
// Seal identity nonce every write gets), then the plaintext. Decrypt enforces
// the keyspace's *current* Read set, as `keyspace::seal_approve` does.

const SEAL_MARKER = [0x53, 0x45, 0x41, 0x4c] // "SEAL"
let sealWrites = 0

jest.unstable_mockModule('../src/seal_helpers', () => ({
  sealEncrypt: async (
    _sealClient: unknown,
    _packageId: string,
    _keyspaceId: string,
    data: Uint8Array,
  ) => {
    sealWrites++
    const nonce = [
      (sealWrites >>> 24) & 0xff,
      (sealWrites >>> 16) & 0xff,
      (sealWrites >>> 8) & 0xff,
      sealWrites & 0xff,
    ]
    return Uint8Array.from([...SEAL_MARKER, ...nonce, ...data])
  },
  sealDecrypt: async (opts: {
    keyspaceId: string
    walletAddress: string
    encryptedData: Uint8Array
  }) => {
    const ks = chain.keyspaces.get(opts.keyspaceId)
    if (!ks || !chain.holdsRole(ks, 'Read', opts.walletAddress)) {
      throw new AclClientError(
        AclError.AccessDenied,
        `seal_approve: ${opts.walletAddress} does not hold Read`,
      )
    }
    const bytes = opts.encryptedData
    for (let i = 0; i < SEAL_MARKER.length; i++) {
      if (bytes[i] !== SEAL_MARKER[i]) throw new Error('not a sealed blob')
    }
    return bytes.slice(SEAL_MARKER.length + 4)
  },
  clearSessionCache: () => {},
}))

// ── Real SDK, imported after the mock is registered ───────────────────────────

const { AclClient } = await import('../src/AclClient')
const { LocationsClient } = await import('../src/locations')
const { updateEntryTx } = await import('../src/transactions')
type Location = import('../src/locations').Location

// ── Scenario helpers ──────────────────────────────────────────────────────────

function makeAclClient(sender: string) {
  return new AclClient({
    suiClient: chain.suiClient,
    sealClient: {},
    packageId: PKG,
    executor: chain.executor(sender),
    storageAdapter: chain.storage,
    ouId: OU_ID,
    apiKey: '',
    // Blobs live in the adapter; skip the generic fetch probe.
    preferAdapterDownload: true,
  })
}

function makeLocation(id: string): Location {
  return {
    id,
    solar_system: 'Sol',
    warp_in: '0,0,0',
    structure_type: 'gate',
    description: `Location ${id}`,
    transponder_setting: 'tribe',
  } as Location
}

const player = (address: string): Principal => ({ type: 'player', address })

interface World {
  writerAcl: InstanceType<typeof AclClient>
  aclId: string
  entryId: string
  list: (wallet?: string) => InstanceType<typeof LocationsClient>
}

/**
 * Writer creates a keyspace and a locations list holding one location, then
 * grants READER the Read role so the list starts out **stale**: the Read set
 * changed after the list was sealed.
 */
async function setupStaleWorld(): Promise<World> {
  const writerAcl = makeAclClient(WRITER)
  const { aclId } = await writerAcl.createAcl({ name: 'Hub list' })
  const created = await LocationsClient.create({
    aclClient: writerAcl,
    aclId,
    walletAddress: WRITER,
    signPersonalMessage: SIGN,
    ouId: OU_ID,
  })
  await created.addLocation(makeLocation('loc-1'))
  const entryId = chain.keyspaces.get(aclId)!.entries[0]

  await writerAcl.grant({
    aclId,
    keyspaceRole: 'Read',
    principal: player(READER),
  })

  const list = (wallet = WRITER) =>
    new LocationsClient({
      aclClient: makeAclClient(wallet),
      aclId,
      entryId,
      walletAddress: wallet,
      signPersonalMessage: SIGN,
      ouId: OU_ID,
    })

  // Reset the counters so each test measures only what it does.
  chain.moveCalls.length = 0
  chain.transactions.length = 0
  chain.storage.uploads = 0
  return { writerAcl, aclId, entryId, list }
}

const onChain = (entryId: string) => chain.entries.get(entryId)!
const version = (aclId: string) => chain.keyspaces.get(aclId)!.version

beforeEach(() => {
  chain = new FakeChain()
  sealWrites = 0
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('setup sanity', () => {
  it('a granted Read role leaves the existing list one epoch behind', async () => {
    const { writerAcl, aclId, entryId } = await setupStaleWorld()

    expect(version(aclId)).toBe(2)
    expect(onChain(entryId).epoch).toBe(1)
    await expect(writerAcl.isEntryStale({ aclId, entryId })).resolves.toBe(true)
    expect(await writerAcl.getStaleEntries(aclId)).toHaveLength(1)
  })

  it('the fake chain aborts update_entry on a current entry, like the contract', async () => {
    const writerAcl = makeAclClient(WRITER)
    const { aclId } = await writerAcl.createAcl({ name: 'Fresh' })
    await LocationsClient.create({
      aclClient: writerAcl,
      aclId,
      walletAddress: WRITER,
      signPersonalMessage: SIGN,
      ouId: OU_ID,
    })
    const entryId = chain.keyspaces.get(aclId)!.entries[0]

    await expect(
      chain.executor(WRITER)(
        updateEntryTx(PKG, aclId, entryId, OU_ID, 'mem://whatever'),
      ),
    ).rejects.toMatchObject({ code: ABORT.EAlreadyCurrentEpoch })
  })
})

describe('adding a location to a stale list', () => {
  it('upgrades the list to the current keyspace epoch in the same single transaction', async () => {
    const { writerAcl, aclId, entryId, list } = await setupStaleWorld()

    const result = await list().applyEdits({ add: [makeLocation('loc-2')] })

    // One decrypt-free write: one upload, one transaction, and that
    // transaction is update_entry — the epoch-advancing variant.
    expect(chain.storage.uploads).toBe(1)
    expect(chain.transactions).toEqual([['keyspace::update_entry']])
    expect(result).toEqual({
      entryId,
      uri: 'mem://blob-1',
      epoch: 2,
      updated: true,
      rotated: true,
    })

    // On-chain: the entry now sits at the keyspace version and points at the
    // new blob.
    expect(onChain(entryId)).toMatchObject({ uri: 'mem://blob-1', epoch: 2 })
    expect(version(aclId)).toBe(2)

    // Through the SDK's own read path the list is no longer stale, so a
    // follow-up rotation has nothing to do.
    expect(await writerAcl.getStaleEntries(aclId)).toEqual([])
    await expect(
      writerAcl.rotateAllStaleEntries({
        aclId,
        walletAddress: WRITER,
        signPersonalMessage: SIGN,
      }),
    ).resolves.toEqual({ rotated: 0, skipped: 0 })

    // And the content is what was asked for.
    const doc = await list().download()
    expect(doc.locations.map((l) => l.id)).toEqual(['loc-1', 'loc-2'])
  })

  it('lets the newly granted reader decrypt the upgraded list', async () => {
    const { list } = await setupStaleWorld()
    await list().applyEdits({ add: [makeLocation('loc-2')] })

    const seenByReader = await list(READER).download()
    expect(seenByReader.locations.map((l) => l.id)).toEqual(['loc-1', 'loc-2'])
  })

  it('the next edit after the upgrade takes the same-epoch path and succeeds', async () => {
    const { entryId, list } = await setupStaleWorld()
    await list().applyEdits({ add: [makeLocation('loc-2')] })
    chain.transactions.length = 0

    // Were editData to pick update_entry here, the fake chain (like the Move
    // module) would abort with EAlreadyCurrentEpoch.
    const result = await list().applyEdits({
      update: [{ id: 'loc-2', changes: { description: 'Renamed' } }],
    })

    expect(chain.transactions).toEqual([['keyspace::edit_entry']])
    expect(result.rotated).toBe(false)
    expect(onChain(entryId)).toMatchObject({ uri: 'mem://blob-2', epoch: 2 })
    const doc = await list().download()
    expect(doc.locations.find((l) => l.id === 'loc-2')?.description).toBe(
      'Renamed',
    )
  })

  it('collapses several Read-set changes into one upgrade to the latest version', async () => {
    const { writerAcl, aclId, entryId, list } = await setupStaleWorld()
    await writerAcl.grant({
      aclId,
      keyspaceRole: 'Read',
      principal: player(OTHER_READER),
    })
    await writerAcl.revoke({
      aclId,
      keyspaceRole: 'Read',
      principal: player(READER),
    })
    expect(version(aclId)).toBe(4)
    expect(onChain(entryId).epoch).toBe(1)
    chain.transactions.length = 0

    const result = await list().applyEdits({ add: [makeLocation('loc-2')] })

    expect(chain.transactions).toEqual([['keyspace::update_entry']])
    expect(result).toMatchObject({ epoch: 4, rotated: true })
    expect(onChain(entryId).epoch).toBe(4)
    expect(await writerAcl.getStaleEntries(aclId)).toEqual([])
  })

  it('seals the written content away from a reader revoked before the edit', async () => {
    const { writerAcl, aclId, list } = await setupStaleWorld()
    // READER could read the list while granted…
    expect((await list(READER).download()).locations).toHaveLength(1)

    await writerAcl.revoke({
      aclId,
      keyspaceRole: 'Read',
      principal: player(READER),
    })
    const result = await list().applyEdits({ add: [makeLocation('loc-2')] })
    expect(result.rotated).toBe(true)

    // …but not the re-sealed list after being revoked.
    await expect(list(READER).download()).rejects.toMatchObject({
      code: AclError.AccessDenied,
    })
    // The writer, still a reader, sees the new content.
    expect((await list().download()).locations).toHaveLength(2)
  })

  it('applies the same upgrade through the single-edit helpers', async () => {
    const { writerAcl, aclId, entryId, list } = await setupStaleWorld()
    const makeStale = async (principal: Principal) => {
      await writerAcl.grant({ aclId, keyspaceRole: 'Read', principal })
      expect(await writerAcl.isEntryStale({ aclId, entryId })).toBe(true)
      chain.transactions.length = 0
    }

    // addLocation — list is already stale from setup.
    chain.transactions.length = 0
    let result = await list().addLocation(makeLocation('loc-2'))
    expect(chain.transactions).toEqual([['keyspace::update_entry']])
    expect(result.rotated).toBe(true)
    expect(onChain(entryId).epoch).toBe(version(aclId))

    // updateLocation
    await makeStale(player(OTHER_READER))
    result = await list().updateLocation('loc-2', { description: 'Moved' })
    expect(chain.transactions).toEqual([['keyspace::update_entry']])
    expect(result.rotated).toBe(true)
    expect(onChain(entryId).epoch).toBe(version(aclId))

    // removeLocation
    await makeStale(player(WRITE_ONLY))
    result = await list().removeLocation('loc-1')
    expect(chain.transactions).toEqual([['keyspace::update_entry']])
    expect(result.rotated).toBe(true)
    expect(onChain(entryId).epoch).toBe(version(aclId))

    const doc = await list().download()
    expect(doc.locations.map((l) => l.id)).toEqual(['loc-2'])
    expect(doc.locations[0].description).toBe('Moved')
  })
})

describe('editing a current list', () => {
  it('stays on the same-epoch edit_entry path', async () => {
    const writerAcl = makeAclClient(WRITER)
    const { aclId } = await writerAcl.createAcl({ name: 'Fresh' })
    const created = await LocationsClient.create({
      aclClient: writerAcl,
      aclId,
      walletAddress: WRITER,
      signPersonalMessage: SIGN,
      ouId: OU_ID,
    })
    const entryId = chain.keyspaces.get(aclId)!.entries[0]
    chain.transactions.length = 0

    const result = await created.applyEdits({ add: [makeLocation('loc-1')] })

    expect(chain.transactions).toEqual([['keyspace::edit_entry']])
    expect(result).toMatchObject({ entryId, epoch: 1, rotated: false })
    expect(onChain(entryId).epoch).toBe(1)
  })

  it('treats a Write-only membership change as non-staling', async () => {
    const writerAcl = makeAclClient(WRITER)
    const { aclId } = await writerAcl.createAcl({ name: 'Fresh' })
    const created = await LocationsClient.create({
      aclClient: writerAcl,
      aclId,
      walletAddress: WRITER,
      signPersonalMessage: SIGN,
      ouId: OU_ID,
    })
    const entryId = chain.keyspaces.get(aclId)!.entries[0]

    // Write grants don't change who can decrypt, so the contract doesn't bump
    // the version and the SDK must not try to rotate.
    await writerAcl.grant({
      aclId,
      keyspaceRole: 'Write',
      principal: player(WRITE_ONLY),
    })
    expect(version(aclId)).toBe(1)
    chain.transactions.length = 0

    const result = await created.applyEdits({ add: [makeLocation('loc-1')] })

    expect(chain.transactions).toEqual([['keyspace::edit_entry']])
    expect(result.rotated).toBe(false)
    expect(onChain(entryId).epoch).toBe(1)
  })
})

describe('failure modes', () => {
  it('a non-writer cannot upgrade or edit the list (ENotAllowed), and nothing is left half-applied', async () => {
    const { entryId, list } = await setupStaleWorld()
    const before = { ...onChain(entryId) }

    // READER holds Read but not Write. The SDK decrypts fine (Read), uploads
    // the new blob, then the on-chain write is rejected.
    await expect(
      list(READER).applyEdits({ add: [makeLocation('loc-2')] }),
    ).rejects.toMatchObject({ code: ABORT.ENotAllowed })

    expect(onChain(entryId)).toEqual(before)
    // The stale list is still stale; the writer's next edit will fix it.
    expect(
      await makeAclClient(WRITER).getStaleEntries(before.keyspace_id),
    ).toHaveLength(1)
  })

  it('a missing entry fails before anything is encrypted or uploaded', async () => {
    const { aclId } = await setupStaleWorld()
    const ghost = new LocationsClient({
      aclClient: makeAclClient(WRITER),
      aclId,
      entryId:
        '0x00000000000000000000000000000000000000000000000000000000deadbeef',
      walletAddress: WRITER,
      signPersonalMessage: SIGN,
      ouId: OU_ID,
    })

    // download() goes through readData, which 404s on the entry first.
    await expect(
      ghost.applyEdits({ add: [makeLocation('loc-2')] }),
    ).rejects.toMatchObject({ code: AclError.EntryNotFound })
    expect(chain.storage.uploads).toBe(0)
    expect(chain.transactions).toEqual([])
  })
})
