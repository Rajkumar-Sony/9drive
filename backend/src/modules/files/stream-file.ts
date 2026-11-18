import type { ConnectedAccount, File } from '../../generated/prisma/client.js'
import type { Response } from 'express'
import { assertProviderCapability, storageProvider } from '../storage-providers/provider.js'

type FileWithAccount = File & { connectedAccount: ConnectedAccount }
type StreamOptions = { disposition?: 'inline' | 'attachment' }

export function streamProviderFile(file: FileWithAccount, range: string | undefined, res: Response, options: StreamOptions = {}) {
  const provider = storageProvider(file.provider)
  assertProviderCapability(provider, 'download')
  return provider.streamFile(file, range, res, options)
}
