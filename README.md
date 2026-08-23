# @trinaryex/keyspace

End-to-end encrypted data sharing using Sui for on-chain access control, Seal threshold encryption for decryption key dissemination and various storage backends for persisting encrypted data. Tested primarily on IPFS via Pinata auth'd pinning service.

```
Client App  ──SDK──>  Sui (ACL membership)
                  ──>  Seal (key servers, enforce policy)
                  ──>  IPFS / Walrus (encrypted blobs)
```

---

## Installation

```sh
yarn add @trinaryex/keyspace @mysten/sui @mysten/seal
```

---

## Quick Start

### 1. Create the client

```ts
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { SealClient } from '@mysten/seal';
import { AclClient, PinataStorageAdapter } from '@trinaryex/keyspace';

const suiClient = new SuiClient({ url: getFullnodeUrl('testnet') });

const sealClient = new SealClient({
  suiClient: suiClient as any,
  serverConfigs: [
    {
      objectId: SEAL_KEY_SERVER_OBJECT_ID,
      weight: 1,
      aggregatorUrl: 'https://seal-aggregator-testnet.mystenlabs.com',
    },
  ],
  verifyKeyServers: false,
});

const aclClient = new AclClient({
  suiClient,
  sealClient,
  packageId: ACL_PACKAGE_ID,

  // Signs and submits PTBs — wrap your wallet's signAndExecuteTransaction here.
  // Must return objectChanges for create/write operations.
  executor: (tx) =>
    signAndExecuteTransaction({ transaction: tx, options: { showObjectChanges: true } }),

  storageAdapter: new PinataStorageAdapter({
    jwt: PINATA_JWT,
    gateway: 'https://your-gateway.mypinata.cloud',
  }),

  // Default OU (org) object id, used as the on-chain `&DAO` witness. Most
  // grant/revoke/read/write calls need one; override it per method as needed.
  ouId: OU_ID,

  // Optional: migrate a keyspace to the v2 principal store on the next
  // mutation. Requires an armature_vault v3+ deployment — see
  // "Migrating a keyspace to the v2 store".
  autoMigrateAcl: false,

  // Optional: REST indexer for getAccessibleAcls().
  // Defaults to the Trinary Exchange API (https://api.trinary.exchange).
  indexerUrl: INDEXER_URL,

  // Required: Trinary Exchange API key, sent as the `x-api-key` header on
  // indexer requests. See https://docs.trinary.exchange/docs/api-keys to
  // create one.
  apiKey: TRINARY_API_KEY,
});
```

### Client-side (browser) apps: use `createPublicAclClient`, not `AclClient`

`apiKey` above is a secret — it authenticates requests to the Trinary
Exchange indexer and must never ship to a browser. If you're wiring up
`AclClient` in a dapp-kit / frontend context (wallet-connected reads,
grants, writes), construct it with `createPublicAclClient` instead of
`new AclClient(...)`:

```ts
import { createPublicAclClient } from '@trinaryex/keyspace';

const aclClient = createPublicAclClient({
  suiClient,
  sealClient,
  packageId: ACL_PACKAGE_ID,
  executor: (tx) =>
    signAndExecuteTransaction({ transaction: tx, options: { showObjectChanges: true } }),
  storageAdapter: new PinataStorageAdapter({ jwt: PINATA_JWT, gateway: PINATA_GATEWAY }),
  // no apiKey — there is no client-side key to supply
});
```

Same config as `new AclClient(...)` minus `apiKey`. The returned
`PublicAclClient` type has every method except `getAccessibleAcls` — `getAcl`,
`createAcl`, `grant`, `revoke`, `rotateAllStaleEntries`, `writeData`/`readData`,
etc. all work exactly as on a full `AclClient`. Only `getAccessibleAcls` reads
`apiKey`, so it's the one method a browser context can't (and shouldn't) call.

Need a user's accessible ACLs in a browser app? Fetch that list from your own
backend: hold a full `AclClient` (constructed with the real `apiKey`)
server-side, call `getAccessibleAcls()` there, and return the result to the
client — the same pattern as any other server-only credential.

`signAndExecuteTransaction` comes from dapp-kit's `useSignAndExecuteTransaction()`. In a Node.js script you can use a keypair instead:

```ts
executor: async (tx) => {
  const bytes = await tx.build({ client: suiClient });
  const result = await suiClient.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showObjectChanges: true },
  });
  return result;
},
```

---

## Usage

### Create a keyspace

```ts
const { aclId, epoch } = await aclClient.createAcl({ name: 'Guild Vault' });
// The creator is seeded into all three roles (Grant, Read, Write).
```

Access is managed by the roles recorded on the keyspace itself — there is no
capability object to hold or transfer. To create one owned by an org (OU)
instead, so an indexer can map OU → keyspaces:

```ts
const { aclId } = await aclClient.createAclForOu({
  name: 'Guild Vault',
  ouId,
  grantPrincipals: [{ type: 'ou', ouId }], // must be non-empty
  readPrincipals: [],
  writePrincipals: [],
});
```

### Roles and principals

A principal holds one or more of three roles: `Grant` (manage membership),
`Read` (decrypt entries), and `Write` (publish/edit entries). A principal is a
wallet (`player`), an org (`ou` — satisfied by any of its governance members),
or a server-held key (`machine`, see below).

Most operations pass an `ouId`, because the contract takes a live `&DAO`
witness to evaluate `ou` principals. Set it once as `ouId` in the client config
and override per method as needed; calls that need it and can't find one throw
`ACL_OU_ID_REQUIRED`.

### Grant access

```ts
await aclClient.grant({
  aclId,
  keyspaceRole: 'Read',
  principal: { type: 'player', address: '0xabc...' },
  ouId,
});
```

### Revoke access

```ts
await aclClient.revoke({
  aclId,
  keyspaceRole: 'Read',
  principal: { type: 'player', address: '0xabc...' },
  ouId,
});
// Revoking Read increments the keyspace epoch, so existing entries become
// stale. Call rotateAllStaleEntries() to re-encrypt them, or the removed member
// keeps read access to everything published before the change.
```

The contract refuses to remove the last principal from any role, so a keyspace
can't be locked out of its own management.

### Machine principals and the v2 ACL

A keyspace has two principal stores. The original one holds `player` and `ou`
principals and can never gain a new kind — its on-chain type is an enum, and Sui
upgrade compatibility freezes a published enum's variant set forever. The v2
store is the upgradeable successor: it carries the kind as data, which is what
makes `machine` principals (server-held keypairs, as opposed to human wallets)
possible at all.

Both stores are live at once. The contract checks both when authorizing, and
reads merge them, so `getAcl()` returns one list per role and you normally never
need to know which store a principal came from:

```ts
// Routed to the v2 store automatically — machine exists nowhere else.
await aclClient.grant({
  aclId,
  keyspaceRole: 'Read',
  principal: { type: 'machine', address: '0xabc...' },
  ouId,
})
```

Machine principals require an armature_vault v3+ deployment.

### Migrating a keyspace to the v2 store

Existing `player`/`ou` principals keep working indefinitely where they are, but
you can lift them into the v2 store. Migration is access-neutral (each principal
still admits exactly the same senders), idempotent, and deliberately does *not*
bump the keyspace epoch — so it never marks entries stale or triggers a
re-encryption sweep. Explicitly:

```ts
await aclClient.migrateAclToV2({ aclId, ouId }) // caller must hold Grant
```

Or set `autoMigrateAcl` and let it happen on the next change to a keyspace's
ACL or entries. Mutations then prepend the migration to their own transaction,
so it costs no extra signature and no separate migration pass:

```ts
const aclClient = new AclClient({ ...config, autoMigrateAcl: true })
```

Each keyspace migrates at most once per client. `grant`/`revoke` always carry
it; entry writes carry it only when the acting wallet also holds `Grant`, since
a writer who is not a grantor would otherwise abort the whole transaction.

Two things to check before turning it on:

- The network you point at must run armature_vault **v3+**. `migrate_acl_to_v2`
  does not exist in earlier deployments, so every mutation would fail.
- Every consumer reading these keyspaces should be on this SDK major. Migration
  empties the object's v1 `acl` field, and an older SDK reads that field
  directly — it would see no principals.

### Write encrypted data

```ts
const { entryId, uri, epoch } = await aclClient.writeData({
  aclId,
  plaintext: 'The treasure is at 32°N, 117°W',
  description: 'Treasure coordinates',
  walletAddress: myAddress,
  signPersonalMessage,
  ouId,
});
```

`uri` is whatever the storage adapter returned (e.g. `ipfs://<cid>`). Reads
resolve it generically, so a reader doesn't need the same adapter that wrote it.

`signPersonalMessage` must be an async function that signs a `Uint8Array` and returns the base64 signature string. In dapp-kit:

```ts
const { mutateAsync: dappKitSign } = useSignPersonalMessage();

const signPersonalMessage = (message: Uint8Array) =>
  new Promise<string>((resolve, reject) =>
    dappKitSign({ message }, { onSuccess: (r) => resolve(r.signature), onError: reject }),
  );
```

### Read encrypted data

```ts
const bytes = await aclClient.readData({
  aclId,
  entryId,
  walletAddress: myAddress,
  signPersonalMessage,
});
const text = new TextDecoder().decode(bytes);
```

Seal session keys are cached in memory for 10 minutes — the wallet prompt appears at most once per TTL window.

### Edit data (same epoch, new content)

```ts
await aclClient.editData({
  aclId,
  entryId,
  newPlaintext: 'Updated coordinates',
  walletAddress: myAddress,
  signPersonalMessage,
});
```

### Rotate stale entries after a membership change

After any change to the **Read** role, existing entries are **stale** (encrypted
under the old epoch). Rotate them so the new membership set applies:

```ts
await aclClient.rotateAllStaleEntries({
  aclId,
  walletAddress: myAddress,
  signPersonalMessage,
  ouId,
  onProgress: (done, total) => console.log(`${done}/${total}`),
});
```

Or rotate one at a time:

```ts
const stale = await aclClient.getStaleEntries(aclId);
for (const entry of stale) {
  await aclClient.rotateEntry({ aclId, entryId: entry.id, walletAddress, signPersonalMessage, ouId });
}

// Or check a single entry without fetching the whole keyspace:
const isStale = await aclClient.isEntryStale({ aclId, entryId });
```

Migrating a keyspace to the v2 principal store does **not** bump the epoch, so
it never triggers a rotation sweep.

### Check access

```ts
// Direct (player/machine) access only.
const allowed = await aclClient.hasAccess({ aclId, address: '0xabc...' });

// Pass ouId to also count access held via an org principal.
const allowedViaOrg = await aclClient.hasAccess({ aclId, address: '0xabc...', ouId });
```

### Inspect keyspace state

```ts
const acl = await aclClient.getAcl(aclId);
// acl.epoch, acl.entries[]
// acl.grantPrincipals[], acl.readPrincipals[], acl.writePrincipals[]
// acl.roles[] — deprecated alias for readPrincipals

// Queries the indexer (defaults to https://api.trinary.exchange). Requires the
// apiKey in config — see https://docs.trinary.exchange/docs/api-keys. Server-side
// only: a client built with createPublicAclClient doesn't expose this method —
// see "Client-side (browser) apps" above.
const accessible = await aclClient.getAccessibleAcls(myAddress);
// string[] — all aclIds where myAddress has any role
```

Each role list is the **union of both principal stores**, so a `machine` granted
in v2 and a `player` still in v1 appear side by side and callers never need to
know which store a principal lives in.

### Read-only clients

If you only ever look up state — a read API, a UI's server route — construct a
`ReadOnlyAclClient`. It needs just a `suiClient` (no `packageId`, `executor`,
`storageAdapter`, or `sealClient`, since it never signs, uploads, or decrypts):

```ts
import { ReadOnlyAclClient } from '@trinaryex/keyspace';

const reader = new ReadOnlyAclClient({ suiClient, apiKey: TRINARY_API_KEY });
await reader.getAcl(aclId);
await reader.hasAccess({ aclId, address, ouId });
await reader.getStaleEntries(aclId);
```

---

## Bring your own storage

Implement `StorageAdapter` to use any blob backend:

```ts
import type { StorageAdapter } from '@trinaryex/keyspace';

class WalrusAdapter implements StorageAdapter {
  // Returns the uri to record on-chain (any scheme your reader can resolve).
  async upload(data: Uint8Array): Promise<string> { /* ... */ }
  async download(uri: string): Promise<Uint8Array> { /* ... */ }
}
```

---

## Error handling

All errors thrown by the SDK are `AclClientError` with a typed `code`:

```ts
import { AclClientError, AclError } from '@trinaryex/keyspace';

try {
  await aclClient.rotateEntry({ aclId, entryId, walletAddress, signPersonalMessage });
} catch (e) {
  if (e instanceof AclClientError && e.code === AclError.AlreadyCurrentEpoch) {
    // Another member already rotated this entry — safe to ignore.
  } else {
    throw e;
  }
}
```

| Code | When |
|---|---|
| `ACL_ACCESS_DENIED` | Seal key servers rejected the decryption request |
| `ACL_ENTRY_NOT_FOUND` | Keyspace or entry object ID does not exist |
| `ACL_ALREADY_CURRENT_EPOCH` | `rotateEntry` called on a non-stale entry |
| `ACL_EPOCH_MISMATCH` | Entry epoch doesn't match the keyspace's current epoch |
| `ACL_ROLE_EXISTS` | Principal already holds the role being granted |
| `ACL_ROLE_NOT_FOUND` | Principal doesn't hold the role being revoked |
| `ACL_OU_ID_REQUIRED` | Operation needs an `ouId` and none was configured or passed |
| `ACL_EXECUTOR_REQUIRED` | A mutation was called on a client built without an `executor` |
| `ACL_STORAGE_ADAPTER_REQUIRED` | A write was called on a client built without a `storageAdapter` |
| `ACL_INDEXER_REQUIRED` | `getAccessibleAcls` called with `indexerUrl` explicitly set to empty |
| `ACL_SESSION_KEY_EXPIRED` | Cached Seal session key outlived its TTL |
| `ACL_STORAGE_UPLOAD_FAILED` | Pinata / storage backend rejected the upload |
| `ACL_STORAGE_FETCH_FAILED` | Blob could not be fetched from the gateway |
| `ACL_VALIDATION_FAILED` | Invalid argument — e.g. a `machine` principal on a v1-only path |
| `ACL_UNEXPECTED_RESPONSE` | Transaction result missing expected object changes |

---

## Environment variables (example app)

```
VITE_ACL_PACKAGE_ID        # Deployed Move package ID
VITE_SEAL_KEY_SERVER_ID    # Seal key server object ID
VITE_PINATA_JWT            # Pinata API token
VITE_PINATA_GATEWAY        # IPFS gateway URL
VITE_INDEXER_URL           # Optional: ACL indexer REST endpoint
VITE_NETWORK               # localnet | devnet | testnet | mainnet
```
