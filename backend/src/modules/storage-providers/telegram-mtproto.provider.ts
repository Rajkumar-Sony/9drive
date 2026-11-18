import type { ConnectedAccount, File } from '../../generated/prisma/client.js'
import { decryptText } from '../../utils/crypto.js'
import { HttpError } from '../../middleware/error.middleware.js'
import { setFileResponseHeaders, pipeToResponse } from '../files/file-response.js'
import { deleteSavedMessage, openSavedMessageDownload, uploadSavedMessage } from '../telegram/mtproto.js'
import { STORAGE_PROVIDER_CAPABILITIES } from './capabilities.js'
import type { StorageProvider } from './provider.js'

function sessionFor(account: ConnectedAccount) {
  if (!account.telegramSessionEncrypted) throw new HttpError(409, 'TELEGRAM_SESSION_MISSING', 'Reconnect this Telegram account to continue.')
  return decryptText(account.telegramSessionEncrypted)
}

function messageIdFor(providerFileId: string) {
  if (!/^[1-9]\d{0,9}$/.test(providerFileId)) throw new HttpError(409, 'TELEGRAM_FILE_ID_INVALID', 'The Telegram file record is invalid.')
  const id = Number(providerFileId)
  if (!Number.isSafeInteger(id)) throw new HttpError(409, 'TELEGRAM_FILE_ID_INVALID', 'The Telegram file record is invalid.')
  return id
}

async function openDownload(file: File & { connectedAccount: ConnectedAccount }) {
  if (file.sizeBytes <= 0n || file.sizeBytes > 2_000_000_000n) throw new HttpError(413, 'PROVIDER_FILE_TOO_LARGE', 'This Telegram file exceeds the supported download limit.')
  return openSavedMessageDownload(sessionFor(file.connectedAccount), messageIdFor(file.providerFileId), file.sizeBytes)
}

export const telegramMtprotoProvider: StorageProvider = {
  type: 'telegram_mtproto',
  capabilities: STORAGE_PROVIDER_CAPABILITIES.telegram_mtproto,
  async syncQuota() {
    throw new HttpError(409, 'PROVIDER_QUOTA_UNAVAILABLE', 'Telegram does not provide storage quota information.')
  },
  async streamFile(file, range, res, options) {
    if (range) return res.status(416).setHeader('Accept-Ranges', 'none').end()
    const body = await openDownload(file)
    setFileResponseHeaders(res, { mimeType: file.mimeType, fileName: file.name, disposition: options?.disposition })
    res.setHeader('Content-Length', file.sizeBytes.toString())
    res.setHeader('Accept-Ranges', 'none')
    return pipeToResponse(body, res)
  },
  async deleteFile(file) {
    await deleteSavedMessage(sessionFor(file.connectedAccount), messageIdFor(file.providerFileId))
  },
  openDownload,
  async uploadStream({ account, name, mimeType, sizeBytes, body }) {
    if (sizeBytes <= 0n || sizeBytes > 2_000_000_000n) throw new HttpError(413, 'PROVIDER_FILE_TOO_LARGE', 'Telegram MTProto supports files up to 2 GB in this application.')
    const message = await uploadSavedMessage(sessionFor(account), { name, mimeType, sizeBytes, body })
    return { providerFileId: String(message.id), providerVersion: String(message.id), confirmedSizeBytes: sizeBytes }
  },
}
