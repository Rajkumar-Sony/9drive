import { STORAGE_PROVIDER_CAPABILITIES } from './capabilities.js'
import type { StorageProvider } from './provider.js'
import { streamGoogleFile } from '../files/stream-google-file.js'
import { google } from '../google/google-apis.js'
import { getAuthedGoogleClient, syncGoogleQuota } from '../google/google.service.js'
import { ensureGoogleAppFolder } from '../google/google.service.js'
import { Readable } from 'node:stream'

export const googleProvider: StorageProvider = {
  type: 'google_drive',
  capabilities: STORAGE_PROVIDER_CAPABILITIES.google_drive,
  syncQuota: syncGoogleQuota,
  streamFile: streamGoogleFile,
  async deleteFile(file) {
    const auth = await getAuthedGoogleClient(file.connectedAccount)
    try {
      await google.drive({ version: 'v3', auth }).files.delete({ fileId: file.providerFileId })
    } catch (error) {
      if ((error as { code?: number }).code !== 404) throw error
    }
  },
  async openDownload(file) {
    const auth = await getAuthedGoogleClient(file.connectedAccount)
    const headers = Object.fromEntries(new Headers(await auth.getRequestHeaders()).entries())
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.providerFileId)}?alt=media`, { headers })
    if (!response.ok || !response.body) throw new Error(`Google Drive download failed (${response.status}).`)
    return Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
  },
  async uploadStream({ account, fileId, name, mimeType, sizeBytes, body }) {
    const auth = await getAuthedGoogleClient(account)
    const drive = google.drive({ version: 'v3', auth })
    const prior = await drive.files.list({
      q: `appProperties has { key='driveconnectTransfer' and value='${fileId}' } and trashed = false`,
      fields: 'files(id,size)', pageSize: 1,
    })
    const existing = prior.data.files?.[0]
    if (existing?.id && BigInt(existing.size ?? -1) === sizeBytes) {
      for await (const _chunk of body) { /* Drain the source so the caller can verify its digest. */ }
      return { providerFileId: existing.id, confirmedSizeBytes: sizeBytes }
    }
    const uploaded = await drive.files.create({
      requestBody: { name, parents: [await ensureGoogleAppFolder(account)], appProperties: { driveconnectTransfer: fileId } },
      media: { mimeType, body },
      fields: 'id',
    })
    const providerFileId = uploaded.data.id
    if (!providerFileId) throw new Error('Google Drive did not return the uploaded file id.')
    const verified = await drive.files.get({ fileId: providerFileId, fields: 'size' })
    const confirmedSizeBytes = BigInt(verified.data.size ?? 0)
    if (confirmedSizeBytes !== sizeBytes) {
      await drive.files.delete({ fileId: providerFileId }).catch(() => undefined)
      throw new Error('Google Drive destination size did not match the source size.')
    }
    return { providerFileId, confirmedSizeBytes }
  },
}
