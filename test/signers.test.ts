import { jest, describe, it, expect } from '@jest/globals'
import { keypairSigner, type PersonalMessageKeypair } from '../src/signers'

const ADDRESS =
  '0x00000000000000000000000000000000000000000000000000000000000000aa'

function makeKeypair(signature = 'base64-sig'): PersonalMessageKeypair {
  return {
    getPublicKey: () => ({ toSuiAddress: () => ADDRESS }),
    signPersonalMessage: jest.fn(async () => ({
      signature,
    })),
  }
}

describe('keypairSigner', () => {
  it('derives walletAddress from the keypair public key', () => {
    const { walletAddress } = keypairSigner(makeKeypair())
    expect(walletAddress).toBe(ADDRESS)
  })

  it('signPersonalMessage returns the bare signature string', async () => {
    const { signPersonalMessage } = keypairSigner(makeKeypair('sig-abc'))
    await expect(signPersonalMessage(new Uint8Array([1, 2, 3]))).resolves.toBe(
      'sig-abc',
    )
  })

  it('passes the message bytes through to the keypair', async () => {
    const keypair = makeKeypair()
    const { signPersonalMessage } = keypairSigner(keypair)
    const message = new Uint8Array([9, 8, 7])

    await signPersonalMessage(message)

    expect(keypair.signPersonalMessage).toHaveBeenCalledWith(message)
  })

  it('propagates keypair signing failures', async () => {
    const keypair: PersonalMessageKeypair = {
      getPublicKey: () => ({ toSuiAddress: () => ADDRESS }),
      signPersonalMessage: jest
        .fn<(message: Uint8Array) => Promise<{ signature: string }>>()
        .mockRejectedValue(new Error('hsm unavailable')),
    }
    const { signPersonalMessage } = keypairSigner(keypair)

    await expect(signPersonalMessage(new Uint8Array())).rejects.toThrow(
      'hsm unavailable',
    )
  })
})
