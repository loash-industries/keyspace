import { jest } from '@jest/globals'
import { AclClient, ReadOnlyAclClient } from '../src/AclClient'
import { AclError } from '../src/errors'
import {
  DEFAULT_GATEWAY,
  resolveGateway,
  resolveIndexerUrl,
} from '../src/gateways'

const OWNER = '0xabc'

function mockFetch(): jest.Mock {
  const fn = jest.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => [{ acl_id: '0x1' }],
  }))
  ;(global as any).fetch = fn
  return fn
}

describe('resolveIndexerUrl', () => {
  it('defaults to Voidwire', () => {
    expect(DEFAULT_GATEWAY).toBe('voidwire')
    expect(resolveIndexerUrl()).toBe('https://api.voidwire.xyz/orgs')
  })

  it('leaves a host untouched on Trinary Exchange', () => {
    expect(resolveIndexerUrl('triex')).toBe('https://api.trinary.exchange')
    expect(resolveIndexerUrl('triex', 'https://idx.test')).toBe(
      'https://idx.test',
    )
  })

  it('keeps Trinary Exchange for an indexerUrl that names it', () => {
    expect(resolveIndexerUrl(undefined, 'https://api.trinary.exchange')).toBe(
      'https://api.trinary.exchange',
    )
    expect(resolveGateway(undefined, 'https://api.trinary.exchange/')).toBe(
      'triex',
    )
  })

  it('lets an explicit gateway beat the indexerUrl', () => {
    expect(resolveGateway('voidwire', 'https://api.trinary.exchange')).toBe(
      'voidwire',
    )
    expect(resolveGateway(undefined, 'https://idx.test')).toBe('voidwire')
    expect(resolveGateway(undefined, 'not a url')).toBe('voidwire')
  })

  it('adds the orgs group on Voidwire, on the default or an overridden host', () => {
    expect(resolveIndexerUrl('voidwire')).toBe('https://api.voidwire.xyz/orgs')
    expect(resolveIndexerUrl('voidwire', 'https://api-dev.test/')).toBe(
      'https://api-dev.test/orgs',
    )
  })

  it('keeps an explicitly empty URL empty', () => {
    expect(resolveIndexerUrl('voidwire', '')).toBe('')
  })
})

describe.each([
  [
    'AclClient',
    (config: object) =>
      new AclClient({ suiClient: {}, sealClient: {}, apiKey: 'k', ...config }),
  ],
  [
    'ReadOnlyAclClient',
    (config: object) =>
      new ReadOnlyAclClient({ suiClient: {}, apiKey: 'k', ...config }),
  ],
])('%s.getAccessibleAcls', (_name, make) => {
  it('reads from Voidwire by default', async () => {
    const fetchMock = mockFetch()
    await expect(make({}).getAccessibleAcls(OWNER)).resolves.toEqual(['0x1'])
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.voidwire.xyz/orgs/v1/players/${OWNER}/accessible-keyspaces`,
      { headers: { 'x-api-key': 'k' } },
    )
  })

  it('reads from Trinary Exchange with `gateway: triex`', async () => {
    const fetchMock = mockFetch()
    await make({ gateway: 'triex' }).getAccessibleAcls(OWNER)
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.trinary.exchange/v1/players/${OWNER}/accessible-keyspaces`,
      { headers: { 'x-api-key': 'k' } },
    )
  })

  it('names the fix when a non-Voidwire key is refused on the default gateway', async () => {
    ;(global as any).fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    }))
    await expect(
      make({ apiKey: 'sk_dev_abc' }).getAccessibleAcls(OWNER),
    ).rejects.toThrow("pass gateway: 'triex'")
  })

  it('keeps the generic advice for a Voidwire key', async () => {
    ;(global as any).fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    }))
    const err = await make({ apiKey: 'sk_vw_abc' })
      .getAccessibleAcls(OWNER)
      .catch((e: Error) => e)
    expect(String(err)).toContain('Check your API key')
    expect(String(err)).not.toContain("gateway: 'triex'")
  })
})

it('AclClient still reports IndexerRequired for an empty URL on Voidwire', async () => {
  const client = new AclClient({
    suiClient: {},
    sealClient: {},
    apiKey: 'k',
    gateway: 'voidwire',
    indexerUrl: '',
  })
  await expect(client.getAccessibleAcls(OWNER)).rejects.toMatchObject({
    code: AclError.IndexerRequired,
  })
})
