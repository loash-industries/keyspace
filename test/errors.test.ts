import { AclError, AclClientError } from '../src/errors'

describe('AclError', () => {
  it('has the expected string values', () => {
    expect(AclError.AccessDenied).toBe('ACL_ACCESS_DENIED')
    expect(AclError.WrongAdminCap).toBe('ACL_WRONG_CAP')
    expect(AclError.AlreadyCurrentEpoch).toBe('ACL_ALREADY_CURRENT_EPOCH')
    expect(AclError.EpochMismatch).toBe('ACL_EPOCH_MISMATCH')
    expect(AclError.RoleAlreadyExists).toBe('ACL_ROLE_EXISTS')
    expect(AclError.RoleNotFound).toBe('ACL_ROLE_NOT_FOUND')
    expect(AclError.EntryNotFound).toBe('ACL_ENTRY_NOT_FOUND')
    expect(AclError.IndexerRequired).toBe('ACL_INDEXER_REQUIRED')
    expect(AclError.SessionKeyExpired).toBe('ACL_SESSION_KEY_EXPIRED')
    expect(AclError.StorageUploadFailed).toBe('ACL_STORAGE_UPLOAD_FAILED')
    expect(AclError.StorageFetchFailed).toBe('ACL_STORAGE_FETCH_FAILED')
    expect(AclError.NotImplemented).toBe('ACL_NOT_IMPLEMENTED')
    expect(AclError.UnexpectedResponse).toBe('ACL_UNEXPECTED_RESPONSE')
  })
})

describe('AclClientError', () => {
  it('sets name, code, and message', () => {
    const err = new AclClientError(
      AclError.AccessDenied,
      'access denied message',
    )
    expect(err.name).toBe('AclClientError')
    expect(err.code).toBe(AclError.AccessDenied)
    expect(err.message).toBe('access denied message')
    expect(err).toBeInstanceOf(Error)
  })

  it('stores the cause when provided', () => {
    const rootCause = new Error('root cause')
    const err = new AclClientError(
      AclError.StorageUploadFailed,
      'upload failed',
      rootCause,
    )
    expect(err.cause).toBe(rootCause)
  })

  it('has undefined cause when not provided', () => {
    const err = new AclClientError(AclError.RoleNotFound, 'role not found')
    expect(err.cause).toBeUndefined()
  })

  it('is catchable as an Error', () => {
    const err = new AclClientError(AclError.EntryNotFound, 'not found')
    expect(() => {
      throw err
    }).toThrow(Error)
    expect(() => {
      throw err
    }).toThrow('not found')
  })

  it('carries the correct code for each error kind', () => {
    for (const code of Object.values(AclError)) {
      const err = new AclClientError(code, 'msg')
      expect(err.code).toBe(code)
    }
  })
})
