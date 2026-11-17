import type { StorageProvider } from './provider.js'
import { deleteS3Object, streamS3File, syncS3Quota } from '../s3/s3.service.js'

export const s3Provider: StorageProvider = {
  type: 's3',
  syncQuota: syncS3Quota,
  streamFile: streamS3File,
  deleteFile: deleteS3Object,
}
