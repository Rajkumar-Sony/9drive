import type { ConnectedAccount, File, StorageAccount } from '../../generated/prisma/client.js'
import type { Response } from 'express'
import { HttpError } from '../../middleware/error.middleware.js'
import { googleProvider } from './google.provider.js'
import { s3Provider } from './s3.provider.js'

export type FileWithAccount = File & { connectedAccount: ConnectedAccount }
export type StreamOptions = { disposition?: 'inline' | 'attachment' }

// Common operations are required. Provider-specific features, such as Google Drive
// folder reconciliation and S3 multipart signing, stay in separate capabilities.
export interface StorageProvider {
  readonly type: 'google_drive' | 's3'
  syncQuota(accountId: string): Promise<StorageAccount>
  streamFile(file: FileWithAccount, range: string | undefined, res: Response, options?: StreamOptions): Promise<void | Response>
  deleteFile(file: FileWithAccount): Promise<void>
}

const providers: Record<StorageProvider['type'], StorageProvider> = {
  google_drive: googleProvider,
  s3: s3Provider,
}

export function storageProvider(type: string): StorageProvider {
  if (type === 'google_drive' || type === 's3') return providers[type]
  throw new HttpError(400, 'UNSUPPORTED_PROVIDER', 'Storage provider is not supported.')
}
