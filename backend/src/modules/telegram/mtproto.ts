import bigInt from 'big-integer'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { Api, TelegramClient } from 'teleproto'
import { SessionPasswordNeededError } from 'teleproto/errors'
import { StringSession } from 'teleproto/sessions'
import { env } from '../../config/env.js'

export type MtprotoCredentials = { apiId: number; apiHash: string }
export type MtprotoClient = Pick<TelegramClient, 'connect' | 'disconnect' | 'sendCode' | 'invoke' | 'getMe' | 'getInputEntity' | 'iterDownload' | 'deleteMessages' | 'signInWithPassword'> & { session: { save(): string } }
export type MtprotoClientFactory = (session: string, credentials: MtprotoCredentials) => MtprotoClient

export function mtprotoCredentials(): MtprotoCredentials {
  if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) throw new Error('Telegram MTProto is not configured on this server.')
  return { apiId: env.TELEGRAM_API_ID, apiHash: env.TELEGRAM_API_HASH }
}

const makeClient: MtprotoClientFactory = (session, credentials) => new TelegramClient(new StringSession(session), credentials.apiId, credentials.apiHash, { connectionRetries: 3, floodSleepThreshold: 30 })

export async function beginTelegramLogin(phone: string, createClient: MtprotoClientFactory = makeClient, credentials: MtprotoCredentials = mtprotoCredentials()) {
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error('Enter a phone number in international format.')
  const client = createClient('', credentials)
  try {
    await client.connect()
    const sent = await client.sendCode(credentials, phone)
    if (!sent.phoneCodeHash || sent.emailRequired) throw new Error('Telegram requires an email verification flow that this connection setup does not support yet.')
    return { phoneCodeHash: sent.phoneCodeHash, isCodeViaApp: sent.isCodeViaApp, session: client.session.save() }
  } finally {
    await client.disconnect().catch(() => undefined)
  }
}

export type FinishLoginInput = { session: string; phone: string; phoneCodeHash: string; code?: string; password?: string }
export type FinishLoginResult = { status: 'password_required'; session: string } | { status: 'complete'; session: string; user: Awaited<ReturnType<TelegramClient['getMe']>> }

export async function finishTelegramLogin(input: FinishLoginInput, createClient: MtprotoClientFactory = makeClient, credentials: MtprotoCredentials = mtprotoCredentials()): Promise<FinishLoginResult> {
  const client = createClient(input.session, credentials)
  try {
    await client.connect()
    if (input.code) {
      try {
        await client.invoke(new Api.auth.SignIn({ phoneNumber: input.phone, phoneCodeHash: input.phoneCodeHash, phoneCode: input.code }))
      } catch (error) {
        if (!(error instanceof SessionPasswordNeededError)) throw error
        if (!input.password) return { status: 'password_required', session: client.session.save() }
      }
    }
    if (!input.code && !input.password) throw new Error('Enter the Telegram login code.')
    if (input.password) await client.signInWithPassword(credentials, { password: async () => input.password!, onError: async () => false })
    const user = await client.getMe()
    if (!user) throw new Error('Telegram did not return the authenticated account.')
    return { status: 'complete', session: client.session.save(), user }
  } finally {
    await client.disconnect().catch(() => undefined)
  }
}

const TELEGRAM_PART_BYTES = 512 * 1024
const MAX_TELEGRAM_PARTS = 4000

export async function* fixedSizeParts(source: AsyncIterable<Uint8Array>, partBytes: number, expectedBytes: bigint) {
  let pending = Buffer.allocUnsafe(partBytes)
  let used = 0
  let total = 0n
  for await (const raw of source) {
    let chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    total += BigInt(chunk.length)
    if (total > expectedBytes) throw new Error('Telegram upload stream exceeded its declared size.')
    while (chunk.length) {
      const copied = Math.min(partBytes - used, chunk.length)
      chunk.copy(pending, used, 0, copied)
      used += copied
      chunk = chunk.subarray(copied)
      if (used === partBytes) {
        yield pending
        pending = Buffer.allocUnsafe(partBytes)
        used = 0
      }
    }
  }
  if (total !== expectedBytes) throw new Error('Telegram upload stream size did not match its declaration.')
  if (used) yield pending.subarray(0, used)
}

function randomLong() { return bigInt(randomBytes(8).readBigUInt64BE().toString()).and(bigInt(2).pow(63).subtract(1)) }

export async function uploadToSavedMessages(client: MtprotoClient, input: { name: string; mimeType: string; sizeBytes: bigint; body: AsyncIterable<Uint8Array> }) {
  if (input.sizeBytes <= 0n || input.sizeBytes > 2_000_000_000n) throw new Error('Telegram MTProto upload size is outside the supported limit.')
  const partCount = Number((input.sizeBytes + BigInt(TELEGRAM_PART_BYTES) - 1n) / BigInt(TELEGRAM_PART_BYTES))
  if (partCount > MAX_TELEGRAM_PARTS) throw new Error('Telegram upload exceeds the protocol part limit.')
  const fileId = randomLong()
  let partIndex = 0
  for await (const bytes of fixedSizeParts(input.body, TELEGRAM_PART_BYTES, input.sizeBytes)) {
    const accepted = await client.invoke(new Api.upload.SaveBigFilePart({ fileId, filePart: partIndex++, fileTotalParts: partCount, bytes }))
    if (!accepted) throw new Error('Telegram rejected an upload part.')
  }
  if (partIndex !== partCount) throw new Error('Telegram upload did not contain the expected number of parts.')
  const file = new Api.InputFileBig({ id: fileId, parts: partCount, name: input.name })
  const media = new Api.InputMediaUploadedDocument({ file, mimeType: input.mimeType || 'application/octet-stream', attributes: [new Api.DocumentAttributeFilename({ fileName: input.name })] })
  const updates = await client.invoke(new Api.messages.SendMedia({ peer: await client.getInputEntity('me'), media, message: '', randomId: randomLong() }))
  if (updates instanceof Api.UpdateShortSentMessage) {
    const messages = await (client as TelegramClient).getMessages('me', { ids: [updates.id] })
    if (messages.length) return messages[0]
  }
  if ('updates' in updates && Array.isArray(updates.updates)) {
    const update = updates.updates.find((candidate) => candidate instanceof Api.UpdateNewMessage || candidate instanceof Api.UpdateNewChannelMessage)
    if (update && 'message' in update && update.message instanceof Api.Message) return update.message
  }
  throw new Error('Telegram accepted the upload but returned no Saved Messages record.')
}

export async function uploadSavedMessage(accountSession: string, input: { name: string; mimeType: string; sizeBytes: bigint; body: AsyncIterable<Uint8Array> }, createClient: MtprotoClientFactory = makeClient, credentials: MtprotoCredentials = mtprotoCredentials()) {
  const client = createClient(accountSession, credentials)
  try {
    await client.connect()
    return await uploadToSavedMessages(client, input)
  } finally {
    await client.disconnect().catch(() => undefined)
  }
}

export function openSavedMessageDownload(accountSession: string, messageId: number, sizeBytes: bigint, createClient: MtprotoClientFactory = makeClient, credentials: MtprotoCredentials = mtprotoCredentials()) {
  const stream = (async function* () {
    const client = createClient(accountSession, credentials)
    try {
      await client.connect()
      const messages = await (client as TelegramClient).getMessages('me', { ids: [messageId] })
      const message = messages[0]
      if (!message || !message.media) throw new Error('Telegram Saved Message was not found.')
      let total = 0n
      for await (const chunk of client.iterDownload(message, { requestSize: 512 * 1024 })) {
        total += BigInt(chunk.length)
        if (total > sizeBytes) throw new Error('Telegram returned more bytes than the recorded file size.')
        yield chunk
      }
      if (total !== sizeBytes) throw new Error('Telegram download size did not match the oneconnect record.')
    } finally {
      await client.disconnect().catch(() => undefined)
    }
  })()
  return Readable.from(stream)
}

export async function deleteSavedMessage(accountSession: string, messageId: number, createClient: MtprotoClientFactory = makeClient, credentials: MtprotoCredentials = mtprotoCredentials()) {
  const client = createClient(accountSession, credentials)
  try {
    await client.connect()
    const messages = await (client as TelegramClient).getMessages('me', { ids: [messageId] })
    if (messages.length) await client.deleteMessages('me', [messageId], { revoke: true })
  } finally {
    await client.disconnect().catch(() => undefined)
  }
}
