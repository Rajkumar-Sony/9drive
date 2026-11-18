import { HttpError } from '../../middleware/error.middleware.js'
import type { StorageProvider } from '../storage-providers/provider.js'

export type TransferKind = 'copy' | 'move' | 'replicate'

export function assertTransferCapabilities(source: Pick<StorageProvider, 'type' | 'capabilities'>, destination: Pick<StorageProvider, 'type' | 'capabilities'>, kind: TransferKind, sizeBytes?: bigint) {
  if (!source.capabilities.download || !destination.capabilities.upload) {
    throw new HttpError(409, 'PROVIDER_OPERATION_UNAVAILABLE', 'The selected providers cannot perform this transfer.')
  }
  if (kind === 'move' && !source.capabilities.delete) {
    throw new HttpError(409, 'PROVIDER_OPERATION_UNAVAILABLE', 'The source provider cannot safely delete this file after transfer.')
  }
  if (sizeBytes !== undefined && source.capabilities.maxDownloadBytes !== null && sizeBytes > source.capabilities.maxDownloadBytes) {
    throw new HttpError(409, 'PROVIDER_FILE_TOO_LARGE', 'A source file exceeds the provider download limit.')
  }
  if (sizeBytes !== undefined && destination.capabilities.maxUploadBytes !== null && sizeBytes > destination.capabilities.maxUploadBytes) {
    throw new HttpError(409, 'PROVIDER_FILE_TOO_LARGE', 'A source file exceeds the destination provider upload limit.')
  }
}
