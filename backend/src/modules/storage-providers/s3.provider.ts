import { STORAGE_PROVIDER_CAPABILITIES } from './capabilities.js'
import type { StorageProvider } from './provider.js'
import { buildS3ObjectKey, createS3Client, deleteS3Key, deleteS3Object, getS3ConfigForAccount, streamS3File, syncS3Quota, uploadS3Object } from '../s3/s3.service.js'
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'

export const s3Provider: StorageProvider = {
  type: 's3',
  capabilities: STORAGE_PROVIDER_CAPABILITIES.s3,
  syncQuota: syncS3Quota,
  streamFile: streamS3File,
  deleteFile: deleteS3Object,
  async openDownload(file) {
    const config = await getS3ConfigForAccount(file.connectedAccountId, file.userId)
    const result = await createS3Client(config).send(new GetObjectCommand({ Bucket: config.bucket, Key: file.providerFileId }))
    if (!(result.Body instanceof Readable)) throw new Error('S3 did not return a readable object stream.')
    return result.Body
  },
  async uploadStream({ userId, account, fileId, name, mimeType, sizeBytes, body }) {
    const config = await getS3ConfigForAccount(account.id, userId)
    const key = buildS3ObjectKey(config, userId, fileId, name)
    await uploadS3Object(config, key, body, mimeType)
    const head = await createS3Client(config).send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }))
    const confirmedSizeBytes = BigInt(head.ContentLength ?? -1)
    if (confirmedSizeBytes !== sizeBytes) {
      await deleteS3Key(config, key).catch(() => undefined)
      throw new Error('S3 destination size did not match the source size.')
    }
    return { providerFileId: key, confirmedSizeBytes }
  },
}
