import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'

type FetchLike = typeof fetch
type TelegramReply<T> = { ok: boolean; result?: T; parameters?: { retry_after?: number } }
export type TelegramDocumentMessage = { message_id: number; document?: { file_id?: string; file_size?: number } }
export type TelegramFile = { file_path?: string; file_size?: number }

export class TelegramBotApiError extends Error {
  constructor(public readonly retryAfterSeconds: number | null = null) {
    super('Telegram Bot API request failed.')
    this.name = 'TelegramBotApiError'
  }
}

export function normalizeBotApiBaseUrl(value: string | undefined, localMode = false) {
  const base = new URL(value || 'https://api.telegram.org')
  if (base.username || base.password) throw new Error('Telegram Bot API endpoint cannot contain credentials.')
  if (base.search || base.hash) throw new Error('Telegram Bot API endpoint cannot contain a query or fragment.')
  if (base.protocol !== 'https:' && !(localMode && base.protocol === 'http:')) throw new Error('Telegram Bot API endpoint must use HTTPS unless local mode is explicitly enabled.')
  if (base.pathname !== '/' && base.pathname !== '') throw new Error('Telegram Bot API endpoint must be an origin without a path.')
  return base.origin
}

export function serializeBotDocumentId(input: { messageId: number; fileId: string }) {
  if (!Number.isSafeInteger(input.messageId) || input.messageId < 1 || !input.fileId || input.fileId.length > 512) throw new Error('Invalid Telegram document identifier.')
  return `tg1:${input.messageId}:${Buffer.from(input.fileId, 'utf8').toString('base64url')}`
}

export function parseBotDocumentId(value: string) {
  const match = /^tg1:([1-9]\d*):([A-Za-z0-9_-]+)$/.exec(value)
  if (!match) throw new Error('Invalid Telegram document identifier.')
  const messageId = Number(match[1])
  const fileId = Buffer.from(match[2], 'base64url').toString('utf8')
  if (!Number.isSafeInteger(messageId) || !fileId || fileId.length > 512 || Buffer.from(fileId, 'utf8').toString('base64url') !== match[2]) throw new Error('Invalid Telegram document identifier.')
  return { messageId, fileId }
}

function safeFilename(value: string) {
  const fallback = value.normalize('NFKD').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file'
  return { fallback, encoded: encodeURIComponent(value).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`) }
}

function multipartDocument(input: { chatId: string; name: string; mimeType: string; sizeBytes: bigint; body: AsyncIterable<Uint8Array> }, boundary: string) {
  const name = safeFilename(input.name)
  const mime = input.mimeType.replace(/[\r\n]/g, '').slice(0, 191) || 'application/octet-stream'
  const chatPart = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${input.chatId}\r\n`)
  const fileHeader = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${name.fallback}"; filename*=UTF-8''${name.encoded}\r\nContent-Type: ${mime}\r\n\r\n`)
  const ending = Buffer.from(`\r\n--${boundary}--\r\n`)
  const stream = Readable.from((async function* () {
    let bytes = 0n
    yield chatPart
    yield fileHeader
    for await (const part of input.body) {
      const chunk = Buffer.from(part)
      bytes += BigInt(chunk.length)
      if (bytes > input.sizeBytes) throw new Error('Telegram upload stream exceeded its declared size.')
      yield chunk
    }
    if (bytes !== input.sizeBytes) throw new Error('Telegram upload stream size did not match its declaration.')
    yield ending
  })())
  const contentLength = BigInt(chatPart.length + fileHeader.length + ending.length) + input.sizeBytes
  return { stream, contentLength }
}

export class TelegramBotApi {
  constructor(private readonly token: string, private readonly baseUrl: string, private readonly fetcher: FetchLike = fetch, localMode = false) {
    if (!/^\d{5,15}:[A-Za-z0-9_-]{20,128}$/.test(token)) throw new Error('Telegram bot token is invalid.')
    normalizeBotApiBaseUrl(baseUrl, localMode)
  }

  private async call<T>(method: string, init: RequestInit = {}) {
    const response = await this.fetcher(`${this.baseUrl}/bot${this.token}/${method}`, { ...init, redirect: 'error' })
    let reply: TelegramReply<T>
    try { reply = await response.json() as TelegramReply<T> } catch { throw new TelegramBotApiError() }
    if (!response.ok || !reply.ok || reply.result === undefined) {
      const delay = Number(reply.parameters?.retry_after)
      throw new TelegramBotApiError(Number.isSafeInteger(delay) && delay > 0 ? Math.min(delay, 3600) : null)
    }
    return reply.result
  }

  getMe() { return this.call<{ id: number; username?: string; first_name?: string }>('getMe') }
  getChat(chatId: string) { return this.call<{ id: number; title?: string; username?: string; first_name?: string }>('getChat', this.jsonBody({ chat_id: chatId })) }

  async sendDocument(input: { chatId: string; name: string; mimeType: string; sizeBytes: bigint; body: AsyncIterable<Uint8Array> }) {
    const boundary = `oneconnect-${randomBytes(18).toString('hex')}`
    const multipart = multipartDocument(input, boundary)
    const result = await this.call<TelegramDocumentMessage>('sendDocument', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': multipart.contentLength.toString() },
      body: multipart.stream as unknown as BodyInit,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    const file = result.document
    if (!Number.isSafeInteger(result.message_id) || result.message_id < 1 || !file?.file_id || !Number.isSafeInteger(file.file_size) || BigInt(file.file_size!) !== input.sizeBytes) throw new Error('Telegram did not confirm the uploaded document size.')
    return { messageId: result.message_id, fileId: file.file_id, confirmedSizeBytes: BigInt(file.file_size!) }
  }

  getFile(fileId: string) { return this.call<TelegramFile>('getFile', this.jsonBody({ file_id: fileId })) }

  async download(filePath: string) {
    if (!filePath || filePath.startsWith('/') || filePath.includes('\\') || filePath.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Telegram returned an invalid file path.')
    const url = new URL(`/file/bot${this.token}/${filePath.split('/').map(encodeURIComponent).join('/')}`, this.baseUrl)
    const response = await this.fetcher(url, { redirect: 'error' })
    if (!response.ok || !response.body) throw new TelegramBotApiError()
    return Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
  }

  deleteMessage(chatId: string, messageId: number) {
    return this.call<boolean>('deleteMessage', this.jsonBody({ chat_id: chatId, message_id: messageId }))
  }

  private jsonBody(body: Record<string, unknown>): RequestInit {
    return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  }
}
