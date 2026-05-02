# @trinaryex/keyspace

End-to-end encrypted data sharing using Sui for on-chain access control, Seal threshold encryption for decryption key dissemination and .

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

  // Optional: enables getAccessibleAcls()
  indexerUrl: INDEXER_URL,
});
```

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

### Create an ACL

```ts
const { aclId, adminCapId, epoch } = await aclClient.createAcl({ name: 'Guild Vault' });
// Store aclId and adminCapId — you need both for role management.
```

### Grant access

```ts
await aclClient.addRole({
  aclId,
  adminCapId,
  role: { type: 'address', address: '0xabc...' },
});
```

### Revoke access

```ts
await aclClient.removeRole({
  aclId,
  adminCapId,
  role: { type: 'address', address: '0xabc...' },
});
// After removeRole the ACL epoch increments. Existing entries become stale.
// Call rotateAllStaleEntries() so the removed member loses read access to old data.
```

### Write encrypted data

```ts
const { entryId, cid, epoch } = await aclClient.writeData({
  aclId,
  plaintext: 'The treasure is at 32°N, 117°W',
  description: 'Treasure coordinates',
  walletAddress: myAddress,
  signPersonalMessage,
});
```

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

After any `addRole` or `removeRole`, existing entries are **stale** (encrypted under the old epoch). Rotate them so the new membership set applies:

```ts
await aclClient.rotateAllStaleEntries({
  aclId,
  walletAddress: myAddress,
  signPersonalMessage,
  onProgress: (done, total) => console.log(`${done}/${total}`),
});
```

Or rotate one at a time:

```ts
const stale = await aclClient.getStaleEntries(aclId);
for (const entry of stale) {
  await aclClient.rotateEntry({ aclId, entryId: entry.id, walletAddress, signPersonalMessage });
}
```

### Check access

```ts
const allowed = await aclClient.hasAccess({ aclId, address: '0xabc...' });
```

### Inspect ACL state

```ts
const acl = await aclClient.getAcl(aclId);
// acl.owner, acl.epoch, acl.roles[], acl.entries[]

const caps = await aclClient.getOwnedAcls(myAddress);
// AdminCap[] — ACLs this wallet can manage

// Requires indexerUrl in config:
const accessible = await aclClient.getAccessibleAcls(myAddress);
// string[] — all aclIds where myAddress has any role
```

### Transfer the AdminCap

```ts
await aclClient.transferAdminCap({ adminCapId, newOwner: multisigAddress });
// Original owner loses write access. New owner gains it.
```

---

## Bring your own storage

Implement `StorageAdapter` to use any blob backend:

```ts
import type { StorageAdapter } from '@trinaryex/keyspace';

class WalrusAdapter implements StorageAdapter {
  async upload(data: Uint8Array): Promise<string> { /* ... */ }
  async download(cid: string): Promise<Uint8Array> { /* ... */ }
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
| `ACL_ENTRY_NOT_FOUND` | ACL or entry object ID does not exist |
| `ACL_ALREADY_CURRENT_EPOCH` | `rotateEntry` called on a non-stale entry |
| `ACL_INDEXER_REQUIRED` | `getAccessibleAcls` called without `indexerUrl` |
| `ACL_NOT_IMPLEMENTED` | Tribe roles (require contract upgrade) |
| `ACL_STORAGE_UPLOAD_FAILED` | Pinata / storage backend rejected the upload |
| `ACL_STORAGE_FETCH_FAILED` | CID could not be fetched from the gateway |
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
