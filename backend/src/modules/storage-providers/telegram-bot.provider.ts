import type { ConnectedAccount, File } from '../../generated/prisma/client.js'
import { env } from '../../config/env.js'
import { decryptText } from '../../utils/crypto.js'
import { HttpError } from '../../middleware/error.middleware.js'
import { setFileResponseHeaders, pipeToResponse } from '../files/file-response.js'
import { TelegramBotApi, parseBotDocumentId, serializeBotDocumentId } from '../telegram/bot-api.js'
import { STORAGE_PROVIDER_CAPABILITIES } from './capabilities.js'
import type { StorageProvider } from './provider.js'

export function telegramBotApi(token: string) {
  const baseUrl = env.TELEGRAM_BOT_API_BASE_URL || 'https://api.telegram.org'
  return new TelegramBotApi(token, baseUrl, fetch, env.TELEGRAM_BOT_API_LOCAL_MODE)
}

function apiFor(account: ConnectedAccount) {
  if (!account.accessTokenEncrypted) throw new Error('Telegram bot credentials are unavailable.')
  return telegramBotApi(decryptText(account.accessTokenEncrypted))
}

const localBotApi = env.TELEGRAM_BOT_API_LOCAL_MODE
async function openDownload(file: File & { connectedAccount: ConnectedAccount }) {
  const id = parseBotDocumentId(file.providerFileId)
  const api = apiFor(file.connectedAccount)
  const info = await api.getFile(id.fileId)
  const maximum = telegramBotProvider.capabilities.maxDownloadBytes
  if (maximum !== null && (file.sizeBytes > maximum || (info.file_size !== undefined && BigInt(info.file_size) > maximum))) throw new HttpError(413, 'PROVIDER_FILE_TOO_LARGE', 'This Telegram file exceeds the configured download limit.')
  if (!info.file_path) throw new Error('Telegram did not return a file path.')
  if (info.file_size !== undefined && BigInt(info.file_size) !== file.sizeBytes) throw new Error('Telegram file size no longer matches its oneconnect record.')
  return api.download(info.file_path)
}

export const telegramBotProvider: StorageProvider = {
  type: 'telegram_bot',
  capabilities: {
    ...STORAGE_PROVIDER_CAPABILITIES.telegram_bot,
    maxUploadBytes: localBotApi ? 2_000_000_000n : 50_000_000n,
    // Local Bot API servers return absolute host paths. Without an explicitly mounted shared
    // volume, the app cannot safely read those paths, and hosted Telegram downloads do not apply.
    download: !localBotApi,
    maxDownloadBytes: localBotApi ? 0n : 20_000_000n,
  },
  async syncQuota() {
    throw new HttpError(409, 'PROVIDER_QUOTA_UNAVAILABLE', 'Telegram Bot API does not provide storage quota information.')
  },
  async streamFile(file, range, res, options) {
    if (range) return res.status(416).setHeader('Accept-Ranges', 'none').end()
    const stream = await openDownload(file)
    setFileResponseHeaders(res, { mimeType: file.mimeType, fileName: file.name, disposition: options?.disposition })
    res.setHeader('Content-Length', file.sizeBytes.toString())
    res.setHeader('Accept-Ranges', 'none')
    return pipeToResponse(stream, res)
  },
  async deleteFile(_file: File & { connectedAccount: ConnectedAccount }) {
    throw new HttpError(409, 'PROVIDER_OPERATION_UNAVAILABLE', 'Telegram Bot API messages cannot be deleted reliably after Telegram’s retention window.')
  },
  openDownload,
  async uploadStream({ account, name, mimeType, sizeBytes, body }) {
    const result = await apiFor(account).sendDocument({ chatId: account.providerAccountId, name, mimeType, sizeBytes, body })
    return { providerFileId: serializeBotDocumentId({ messageId: result.messageId, fileId: result.fileId }), providerVersion: String(result.messageId), confirmedSizeBytes: result.confirmedSizeBytes }
  },
}
