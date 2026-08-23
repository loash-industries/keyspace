import { jest, describe, it, expect } from '@jest/globals'
import { MachinesClient, MACHINES_ENTRY_DESCRIPTION } from '../src/machines'
import type { MachinesDocument } from '../src/machines-schemas'
import { MACHINES_SCHEMA_NAME } from '../src/machines-schemas'
import { AclClientError } from '../src/errors'
import type { AclClient } from '../src/AclClient'

const ACL_ID =
  '0x0000000000000000000000000000000000000000000000000000000000001001'
const ENTRY_ID =
  '0x0000000000000000000000000000000000000000000000000000000000001002'
const OU_ID =
  '0x0000000000000000000000000000000000000000000000000000000000001003'
const WALLET =
  '0x00000000000000000000000000000000000000000000000000000000000000bb'
const MACHINE =
  '0x00000000000000000000000000000000000000000000000000000000000000aa'

const signPersonalMessage = async () => 'sig'

function makeDocument(
  machines: MachinesDocument['machines'] = {},
): MachinesDocument {
  return {
    schema: MACHINES_SCHEMA_NAME,
    schema_version: 1,
    updated_at: '2026-08-23T00:00:00.000Z',
    machines,
  }
}

function encodeDocument(doc: MachinesDocument): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(doc))
}

function makeAclStub(doc: MachinesDocument) {
  return {
    readData: (jest.fn() as any).mockResolvedValue(encodeDocument(doc)),
    editData: (jest.fn() as any).mockResolvedValue({
      entryId: ENTRY_ID,
      uri: 'ipfs://QmNew',
      epoch: 1,
    }),
    writeData: (jest.fn() as any).mockResolvedValue({
      entryId: ENTRY_ID,
      uri: 'ipfs://QmNew',
      epoch: 0,
    }),
    rotateEntry: (jest.fn() as any).mockResolvedValue({
      newUri: 'ipfs://QmRotated',
      epoch: 2,
    }),
    getAcl: jest.fn() as any,
  }
}

function makeClient(stub: ReturnType<typeof makeAclStub>) {
  return new MachinesClient({
    aclClient: stub as unknown as AclClient,
    aclId: ACL_ID,
    entryId: ENTRY_ID,
    walletAddress: WALLET,
    signPersonalMessage,
    ouId: OU_ID,
  })
}

function writtenDocument(
  stub: ReturnType<typeof makeAclStub>,
): MachinesDocument {
  const call = (stub.editData as jest.Mock).mock.calls[0][0] as {
    newPlaintext: string
  }
  return JSON.parse(call.newPlaintext)
}

describe('MachinesClient.download', () => {
  it('decrypts and parses the machines document', async () => {
    const doc = makeDocument({
      [MACHINE]: {
        label: 'estuary enricher',
        added_by: WALLET,
        added_at: '2026-08-23T00:00:00.000Z',
      },
    })
    const stub = makeAclStub(doc)
    const client = makeClient(stub)

    const result = await client.download()

    expect(result.machines[MACHINE]!.label).toBe('estuary enricher')
    expect(stub.readData).toHaveBeenCalledWith({
      aclId: ACL_ID,
      entryId: ENTRY_ID,
      walletAddress: WALLET,
      signPersonalMessage,
      ouId: OU_ID,
    })
  })

  it('throws ACL_VALIDATION_FAILED on a malformed stored document', async () => {
    const stub = makeAclStub(makeDocument())
    stub.readData.mockResolvedValue(
      new TextEncoder().encode(JSON.stringify({ hello: 'world' })),
    )
    const client = makeClient(stub)

    await expect(client.download()).rejects.toThrow(AclClientError)
  })
})

describe('MachinesClient.upsert', () => {
  it('inserts a new row stamped with the client wallet', async () => {
    const stub = makeAclStub(makeDocument())
    const client = makeClient(stub)

    await client.upsert(MACHINE, { label: 'hauling bot' })

    const doc = writtenDocument(stub)
    expect(doc.machines[MACHINE]!.label).toBe('hauling bot')
    expect(doc.machines[MACHINE]!.added_by).toBe(WALLET)
    expect(doc.machines[MACHINE]!.added_at).toBeTruthy()
  })

  it('normalizes the machine address to lowercase', async () => {
    const stub = makeAclStub(makeDocument())
    const client = makeClient(stub)

    await client.upsert(MACHINE.toUpperCase().replace('0X', '0x'), {
      label: 'bot',
    })

    expect(writtenDocument(stub).machines[MACHINE]).toBeDefined()
  })

  it('updates the label while preserving added_by and added_at', async () => {
    const stub = makeAclStub(
      makeDocument({
        [MACHINE]: {
          label: 'old label',
          added_by:
            '0x00000000000000000000000000000000000000000000000000000000000000cc',
          added_at: '2020-01-01T00:00:00.000Z',
        },
      }),
    )
    const client = makeClient(stub)

    await client.upsert(MACHINE, { label: 'new label' })

    const row = writtenDocument(stub).machines[MACHINE]!
    expect(row.label).toBe('new label')
    expect(row.added_by).toBe(
      '0x00000000000000000000000000000000000000000000000000000000000000cc',
    )
    expect(row.added_at).toBe('2020-01-01T00:00:00.000Z')
  })

  it('rejects an invalid machine address before any decrypt', async () => {
    const stub = makeAclStub(makeDocument())
    const client = makeClient(stub)

    await expect(client.upsert('0x1234', { label: 'bot' })).rejects.toThrow(
      AclClientError,
    )
    expect(stub.readData).not.toHaveBeenCalled()
  })

  it('rejects an empty label', async () => {
    const stub = makeAclStub(makeDocument())
    const client = makeClient(stub)

    await expect(client.upsert(MACHINE, { label: '' })).rejects.toThrow(
      AclClientError,
    )
  })
})

describe('MachinesClient.remove', () => {
  it('removes an existing row', async () => {
    const stub = makeAclStub(
      makeDocument({
        [MACHINE]: {
          label: 'bot',
          added_by: WALLET,
          added_at: '2026-08-23T00:00:00.000Z',
        },
      }),
    )
    const client = makeClient(stub)

    await client.remove(MACHINE)

    expect(writtenDocument(stub).machines[MACHINE]).toBeUndefined()
  })

  it('throws ACL_ENTRY_NOT_FOUND for an absent row', async () => {
    const stub = makeAclStub(makeDocument())
    const client = makeClient(stub)

    await expect(client.remove(MACHINE)).rejects.toThrow(AclClientError)
    expect(stub.editData).not.toHaveBeenCalled()
  })
})

describe('MachinesClient.reencrypt', () => {
  it('delegates to rotateEntry for this entry', async () => {
    const stub = makeAclStub(makeDocument())
    const client = makeClient(stub)

    const result = await client.reencrypt()

    expect(result.epoch).toBe(2)
    expect(stub.rotateEntry).toHaveBeenCalledWith({
      aclId: ACL_ID,
      entryId: ENTRY_ID,
      walletAddress: WALLET,
      signPersonalMessage,
      ouId: OU_ID,
    })
  })
})

describe('MachinesClient.open', () => {
  const baseOpts = {
    aclId: ACL_ID,
    walletAddress: WALLET,
    signPersonalMessage,
    ouId: OU_ID,
  }

  it('finds the entry by its machines description', async () => {
    const stub = makeAclStub(makeDocument())
    stub.getAcl.mockResolvedValue({
      entries: [
        { id: '0xother', description: 'locations' },
        { id: ENTRY_ID, description: MACHINES_ENTRY_DESCRIPTION },
      ],
    })

    const client = await MachinesClient.open({
      ...baseOpts,
      aclClient: stub as unknown as AclClient,
    })

    expect(client).not.toBeNull()
    await client!.download()
    expect(stub.readData).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: ENTRY_ID }),
    )
  })

  it('returns null when the keyspace has no machines entry', async () => {
    const stub = makeAclStub(makeDocument())
    stub.getAcl.mockResolvedValue({
      entries: [{ id: '0xother', description: 'locations' }],
    })

    const client = await MachinesClient.open({
      ...baseOpts,
      aclClient: stub as unknown as AclClient,
    })

    expect(client).toBeNull()
  })
})

describe('MachinesClient.create', () => {
  it('writes an empty document under the machines description', async () => {
    const stub = makeAclStub(makeDocument())
    const client = await MachinesClient.create({
      aclClient: stub as unknown as AclClient,
      aclId: ACL_ID,
      walletAddress: WALLET,
      signPersonalMessage,
      ouId: OU_ID,
    })

    expect(client).toBeInstanceOf(MachinesClient)
    const call = (stub.writeData as jest.Mock).mock.calls[0][0] as {
      description: string
      plaintext: string
    }
    expect(call.description).toBe(MACHINES_ENTRY_DESCRIPTION)
    const doc = JSON.parse(call.plaintext) as MachinesDocument
    expect(doc.schema).toBe(MACHINES_SCHEMA_NAME)
    expect(doc.machines).toEqual({})
  })
})
