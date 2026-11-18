import type { ConnectedAccount, File, StorageAccount } from '../../generated/prisma/client.js'
import type { Response } from 'express'
import type { Readable } from 'node:stream'
import { HttpError } from '../../middleware/error.middleware.js'
import { STORAGE_PROVIDER_CAPABILITIES } from './capabilities.js'
import type { StorageProviderId, StorageProviderOperation, StorageProviderCapabilities } from './capabilities.js'
import { googleProvider } from './google.provider.js'
import { s3Provider } from './s3.provider.js'
import { oneDriveProvider } from './onedrive.provider.js'
import { telegramBotProvider } from './telegram-bot.provider.js'
import { telegramMtprotoProvider } from './telegram-mtproto.provider.js'

export { STORAGE_PROVIDER_CAPABILITIES } from './capabilities.js'
export type { StorageProviderId, StorageProviderOperation, StorageProviderCapabilities } from './capabilities.js'

export type FileWithAccount = File & { connectedAccount: ConnectedAccount }
export type StreamOptions = { disposition?: 'inline' | 'attachment' }

export function assertProviderCapability(
  provider: Pick<StorageProvider, 'type' | 'capabilities'>,
  operation: StorageProviderOperation,
): void {
  if (!provider.capabilities[operation]) {
    throw new HttpError(409, 'PROVIDER_OPERATION_UNAVAILABLE', `Provider '${provider.type}' does not support ${operation}.`)
  }
}

// Common operations are required. Provider-specific features, such as Google Drive
// folder reconciliation and S3 multipart signing, stay in separate capabilities.
export interface StorageProvider {
  readonly type: StorageProviderId
  readonly capabilities: StorageProviderCapabilities
  syncQuota(accountId: string): Promise<StorageAccount>
  streamFile(file: FileWithAccount, range: string | undefined, res: Response, options?: StreamOptions): Promise<void | Response>
  deleteFile(file: FileWithAccount): Promise<void>
  openDownload(file: FileWithAccount): Promise<Readable>
  uploadStream(input: { userId: string; account: ConnectedAccount; fileId: string; name: string; mimeType: string; sizeBytes: bigint; body: Readable }): Promise<{ providerFileId: string; confirmedSizeBytes: bigint; providerVersion?: string }>
}

const providers: Partial<Record<StorageProvider['type'], StorageProvider>> = {
  google_drive: googleProvider,
  s3: s3Provider,
  onedrive: oneDriveProvider,
  telegram_bot: telegramBotProvider,
  telegram_mtproto: telegramMtprotoProvider,
}

export function storageProvider(type: string): StorageProvider {
  if (type in providers) {
    const provider = providers[type as StorageProviderId]
    if (provider) return provider
  }
  throw new HttpError(400, 'UNSUPPORTED_PROVIDER', `Storage provider '${type}' is not available.`)
}
