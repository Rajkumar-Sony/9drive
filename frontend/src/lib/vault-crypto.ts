import sodium from 'libsodium-wrappers-sumo'

const MAGIC = new TextEncoder().encode('9DVLT001')
const CONTENT_CHUNK_BYTES = 256 * 1024
const FORMAT_VERSION = 1

export type VaultMetadata = { name: string; mimeType: string; sizeBytes: number; createdAt: string }
export type VaultEnvelope = {
  formatVersion: 1
  salt: string
  keyWrap: string
  encryptedMetadata: string
  encryptionAlgorithm: 'xchacha20poly1305-secretstream+argon2id-v1'
}
type KeyWrapV1 = { version: 1; opsLimit: number; memLimit: number; passphrase: { nonce: string; cipher: string }; recovery: { nonce: string; cipher: string } }

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const b64 = (data: Uint8Array) => sodium.to_base64(data, sodium.base64_variants.URLSAFE_NO_PADDING)
const unb64 = (data: string) => sodium.from_base64(data, sodium.base64_variants.URLSAFE_NO_PADDING)

async function ready() { await sodium.ready }

function wrapKey(key: Uint8Array, wrappingKey: Uint8Array) {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
  return { nonce: b64(nonce), cipher: b64(sodium.crypto_secretbox_easy(key, nonce, wrappingKey)) }
}

function unwrapKey(wrapped: { nonce: string; cipher: string }, wrappingKey: Uint8Array) {
  const key = sodium.crypto_secretbox_open_easy(unb64(wrapped.cipher), unb64(wrapped.nonce), wrappingKey)
  if (!key || key.length !== sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES) throw new Error('Vault key could not be unlocked.')
  return key
}

function frame(cipher: Uint8Array) {
  const framed = new Uint8Array(4 + cipher.length)
  new DataView(framed.buffer).setUint32(0, cipher.length, false)
  framed.set(cipher, 4)
  return framed
}

export async function encryptVaultStream(source: ReadableStream<Uint8Array>, passphrase: string, metadata: VaultMetadata, onProgress?: (bytes: number) => void): Promise<{ stream: ReadableStream<Uint8Array>; envelope: VaultEnvelope; recoveryKey: string; cipherSizeBytes: bigint }> {
  await ready()
  if (passphrase.length < 12) throw new Error('Use a vault passphrase with at least 12 characters.')
  if (!Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes < 0 || !metadata.name) throw new Error('Vault metadata is invalid.')
  const opsLimit = sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE
  const memLimit = sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES)
  const fileKey = sodium.crypto_secretstream_xchacha20poly1305_keygen()
  const passphraseKey = sodium.crypto_pwhash(sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES, passphrase, salt, opsLimit, memLimit, sodium.crypto_pwhash_ALG_ARGON2ID13)
  const recoveryBytes = sodium.randombytes_buf(sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES)
  const recoveryKey = b64(recoveryBytes)
  const wrapped: KeyWrapV1 = { version: FORMAT_VERSION, opsLimit, memLimit, passphrase: wrapKey(fileKey, passphraseKey), recovery: wrapKey(fileKey, recoveryBytes) }
  const metadataNonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
  const encryptedMetadata = sodium.crypto_secretbox_easy(encoder.encode(JSON.stringify(metadata)), metadataNonce, fileKey)
  const envelope: VaultEnvelope = {
    formatVersion: FORMAT_VERSION,
    salt: b64(salt),
    keyWrap: JSON.stringify(wrapped),
    encryptedMetadata: b64(new Uint8Array([...metadataNonce, ...encryptedMetadata])),
    encryptionAlgorithm: 'xchacha20poly1305-secretstream+argon2id-v1',
  }
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(fileKey)
  sodium.memzero(fileKey)
  sodium.memzero(recoveryBytes)
  const reader = source.getReader()
  let consumed = 0
  let current: Uint8Array | undefined
  let offset = 0
  let sourceEnded = false
  let finished = false
  const pending = new Uint8Array(CONTENT_CHUNK_BYTES)
  let pendingSize = 0
  const messageCount = Math.ceil(metadata.sizeBytes / CONTENT_CHUNK_BYTES)
  const cipherSizeBytes = BigInt(MAGIC.length + sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES + metadata.sizeBytes + (messageCount + 1) * (4 + sodium.crypto_secretstream_xchacha20poly1305_ABYTES))
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (finished) return
        if (consumed === 0) controller.enqueue(new Uint8Array([...MAGIC, ...header]))
        if (sourceEnded && pendingSize === 0) {
          const finalCipher = sodium.crypto_secretstream_xchacha20poly1305_push(state, new Uint8Array(), null, sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL)
          controller.enqueue(frame(finalCipher))
          controller.close()
          finished = true
          return
        }
        while (pendingSize < CONTENT_CHUNK_BYTES && !sourceEnded) {
          while (!current || offset >= current.length) {
            const next = await reader.read()
            if (next.done) { sourceEnded = true; break }
            current = next.value
            offset = 0
            if (current.length === 0) continue
          }
          if (sourceEnded) break
          const size = Math.min(CONTENT_CHUNK_BYTES - pendingSize, current!.length - offset)
          pending.set(current!.subarray(offset, offset + size), pendingSize)
          pendingSize += size
          offset += size
          consumed += size
          if (consumed > metadata.sizeBytes) throw new Error('Vault input exceeded its declared size.')
          onProgress?.(consumed)
        }
        if (sourceEnded && consumed !== metadata.sizeBytes) throw new Error('Vault input size changed while encrypting.')
        if (pendingSize === 0 && sourceEnded) {
          const finalCipher = sodium.crypto_secretstream_xchacha20poly1305_push(state, new Uint8Array(), null, sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL)
          controller.enqueue(frame(finalCipher))
          controller.close()
          finished = true
          return
        }
        const cipher = sodium.crypto_secretstream_xchacha20poly1305_push(state, pending.subarray(0, pendingSize), null, sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE)
        pending.fill(0, 0, pendingSize)
        pendingSize = 0
        controller.enqueue(frame(cipher))
      } catch (error) {
        await reader.cancel(error).catch(() => undefined)
        controller.error(error)
        finished = true
      }
    },
    async cancel(reason) { finished = true; await reader.cancel(reason) },
  })
  sodium.memzero(passphraseKey)
  return { stream, envelope, recoveryKey, cipherSizeBytes }
}

export async function decryptVaultStream(source: ReadableStream<Uint8Array>, keyWrapJson: string, saltText: string, unlock: { passphrase: string } | { recoveryKey: string }): Promise<ReadableStream<Uint8Array>> {
  await ready()
  const wrap = JSON.parse(keyWrapJson) as KeyWrapV1
  if (wrap.version !== 1 || !Number.isSafeInteger(wrap.opsLimit) || !Number.isSafeInteger(wrap.memLimit) || wrap.opsLimit !== sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE || wrap.memLimit !== sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE) throw new Error('Vault key envelope is invalid.')
  const salt = unb64(saltText)
  if (salt.length !== sodium.crypto_pwhash_SALTBYTES) throw new Error('Vault salt is invalid.')
  let wrappingKey: Uint8Array
  let wrappedKey: KeyWrapV1['passphrase']
  if ('passphrase' in unlock) {
    if (unlock.passphrase.length < 1) throw new Error('Enter the vault passphrase.')
    wrappingKey = sodium.crypto_pwhash(sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES, unlock.passphrase, salt, wrap.opsLimit, wrap.memLimit, sodium.crypto_pwhash_ALG_ARGON2ID13)
    wrappedKey = wrap.passphrase
  } else {
    wrappingKey = unb64(unlock.recoveryKey)
    if (wrappingKey.length !== sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES) throw new Error('Vault recovery key is invalid.')
    wrappedKey = wrap.recovery
  }
  const fileKey = unwrapKey(wrappedKey, wrappingKey)
  sodium.memzero(wrappingKey)
  const reader = source.getReader()
  let buffered = new Uint8Array()
  let initialized = false
  let state: ReturnType<typeof sodium.crypto_secretstream_xchacha20poly1305_init_pull> | undefined
  let sawFinal = false
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          if (!initialized) {
            while (buffered.length < MAGIC.length + sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES) {
              const next = await reader.read()
              if (next.done) throw new Error('Vault data is truncated.')
              buffered = append(buffered, next.value)
            }
            for (let i = 0; i < MAGIC.length; i++) if (buffered[i] !== MAGIC[i]) throw new Error('Vault file format is not supported.')
            state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(buffered.subarray(MAGIC.length, MAGIC.length + sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES), fileKey)
            sodium.memzero(fileKey)
            buffered = buffered.subarray(MAGIC.length + sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES)
            initialized = true
          }
          while (buffered.length < 4) {
            const next = await reader.read()
            if (next.done) {
              if (!sawFinal) throw new Error('Vault data ended before its authenticated final marker.')
              controller.close()
              return
            }
            buffered = append(buffered, next.value)
          }
          const length = new DataView(buffered.buffer, buffered.byteOffset, buffered.byteLength).getUint32(0, false)
          if (length < sodium.crypto_secretstream_xchacha20poly1305_ABYTES || length > CONTENT_CHUNK_BYTES + sodium.crypto_secretstream_xchacha20poly1305_ABYTES) throw new Error('Vault chunk length is invalid.')
          while (buffered.length < 4 + length) {
            const next = await reader.read()
            if (next.done) throw new Error('Vault chunk is truncated.')
            buffered = append(buffered, next.value)
          }
          const result = sodium.crypto_secretstream_xchacha20poly1305_pull(state!, buffered.subarray(4, 4 + length), null)
          buffered = buffered.subarray(4 + length)
          if (!result) throw new Error('Vault integrity check failed. The password may be wrong or data was changed.')
          if (result.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL) {
            if (buffered.length) throw new Error('Unexpected bytes followed the vault final marker.')
            sawFinal = true
            const next = await reader.read()
            if (!next.done) throw new Error('Unexpected bytes followed the vault final marker.')
            controller.close()
            return
          }
          if (result.tag !== sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE) throw new Error('Unsupported vault stream tag.')
          if (result.message.length) { controller.enqueue(result.message); return }
        }
      } catch (error) {
        await reader.cancel(error).catch(() => undefined)
        controller.error(error)
      }
    },
    async cancel(reason) { await reader.cancel(reason) },
  })
  return stream
}

export async function decryptVaultMetadata(encryptedMetadata: string, keyWrapJson: string, saltText: string, unlock: { passphrase: string } | { recoveryKey: string }): Promise<VaultMetadata> {
  await ready()
  const wrap = JSON.parse(keyWrapJson) as KeyWrapV1
  if (wrap.version !== 1 || wrap.opsLimit !== sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE || wrap.memLimit !== sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE) throw new Error('Vault key envelope is invalid.')
  const salt = unb64(saltText)
  let wrappingKey: Uint8Array
  let wrappedKey: KeyWrapV1['passphrase']
  if ('passphrase' in unlock) {
    wrappingKey = sodium.crypto_pwhash(sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES, unlock.passphrase, salt, wrap.opsLimit, wrap.memLimit, sodium.crypto_pwhash_ALG_ARGON2ID13)
    wrappedKey = wrap.passphrase
  } else {
    wrappingKey = unb64(unlock.recoveryKey)
    wrappedKey = wrap.recovery
  }
  const fileKey = unwrapKey(wrappedKey, wrappingKey)
  sodium.memzero(wrappingKey)
  const bytes = unb64(encryptedMetadata)
  if (bytes.length <= sodium.crypto_secretbox_NONCEBYTES) throw new Error('Vault metadata is truncated.')
  const nonce = bytes.subarray(0, sodium.crypto_secretbox_NONCEBYTES)
  const plaintext = sodium.crypto_secretbox_open_easy(bytes.subarray(sodium.crypto_secretbox_NONCEBYTES), nonce, fileKey)
  sodium.memzero(fileKey)
  if (!plaintext) throw new Error('Vault metadata could not be decrypted.')
  const value = JSON.parse(decoder.decode(plaintext)) as VaultMetadata
  if (!value || typeof value.name !== 'string' || typeof value.mimeType !== 'string' || !Number.isSafeInteger(value.sizeBytes)) throw new Error('Vault metadata is invalid.')
  return value
}

function append(left: Uint8Array, right: Uint8Array) {
  const result = new Uint8Array(left.length + right.length)
  result.set(left)
  result.set(right, left.length)
  return result
}
