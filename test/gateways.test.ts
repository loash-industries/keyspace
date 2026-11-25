import { jest } from '@jest/globals'
import { AclClient, ReadOnlyAclClient } from '../src/AclClient'
import { AclError } from '../src/errors'
import { resolveIndexerUrl } from '../src/gateways'

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
  it('defaults to Trinary Exchange and leaves an override untouched', () => {
    expect(resolveIndexerUrl()).toBe('https://api.trinary.exchange')
    expect(resolveIndexerUrl('triex', 'https://idx.test')).toBe(
      'https://idx.test',
    )
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
  it('reads from Trinary Exchange by default', async () => {
    const fetchMock = mockFetch()
    await expect(make({}).getAccessibleAcls(OWNER)).resolves.toEqual(['0x1'])
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.trinary.exchange/v1/players/${OWNER}/accessible-keyspaces`,
      { headers: { 'x-api-key': 'k' } },
    )
  })

  it('reads from Voidwire with `gateway: voidwire`', async () => {
    const fetchMock = mockFetch()
    await make({ gateway: 'voidwire' }).getAccessibleAcls(OWNER)
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.voidwire.xyz/orgs/v1/players/${OWNER}/accessible-keyspaces`,
      { headers: { 'x-api-key': 'k' } },
    )
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
