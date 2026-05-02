export enum AclError {
  AccessDenied        = 'ACL_ACCESS_DENIED',
  WrongAdminCap       = 'ACL_WRONG_CAP',
  AlreadyCurrentEpoch = 'ACL_ALREADY_CURRENT_EPOCH',
  EpochMismatch       = 'ACL_EPOCH_MISMATCH',
  RoleAlreadyExists   = 'ACL_ROLE_EXISTS',
  RoleNotFound        = 'ACL_ROLE_NOT_FOUND',
  EntryNotFound       = 'ACL_ENTRY_NOT_FOUND',
  IndexerRequired     = 'ACL_INDEXER_REQUIRED',
  SessionKeyExpired   = 'ACL_SESSION_KEY_EXPIRED',
  StorageUploadFailed = 'ACL_STORAGE_UPLOAD_FAILED',
  StorageFetchFailed  = 'ACL_STORAGE_FETCH_FAILED',
  NotImplemented      = 'ACL_NOT_IMPLEMENTED',
  UnexpectedResponse  = 'ACL_UNEXPECTED_RESPONSE',
}

export class AclClientError extends Error {
  constructor(
    public readonly code: AclError,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AclClientError';
  }
}
