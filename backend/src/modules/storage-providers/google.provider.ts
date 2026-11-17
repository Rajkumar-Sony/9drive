import type { StorageProvider } from './provider.js'
import { streamGoogleFile } from '../files/stream-google-file.js'
import { google } from '../google/google-apis.js'
import { getAuthedGoogleClient, syncGoogleQuota } from '../google/google.service.js'

export const googleProvider: StorageProvider = {
  type: 'google_drive',
  syncQuota: syncGoogleQuota,
  streamFile: streamGoogleFile,
  async deleteFile(file) {
    const auth = await getAuthedGoogleClient(file.connectedAccount)
    await google.drive({ version: 'v3', auth }).files.delete({ fileId: file.providerFileId })
  },
}
