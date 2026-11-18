import assert from 'node:assert/strict'
import test from 'node:test'
import { decryptVaultMetadata, decryptVaultStream, encryptVaultStream } from '../src/lib/vault-crypto.ts'

async function collect(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  while (true) {
    const next = await reader.read()
    if (next.done) break
    parts.push(next.value)
  }
  return parts
}

function concat(parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.length }
  return result
}

test('vault uses authenticated chunk encryption with passphrase and independent recovery key', async () => {
  const plain = new TextEncoder().encode('vault content with private name and mime')
  const encrypted = await encryptVaultStream(new ReadableStream({ start(controller) { controller.enqueue(plain); controller.close() } }), 'correct horse battery staple', {
    name: 'private-report.txt', mimeType: 'text/plain', sizeBytes: plain.length, createdAt: '2026-11-18T00:00:00.000Z',
  })
  const cipherParts = await collect(encrypted.stream)
  const cipher = concat(cipherParts)
  assert.equal(BigInt(cipher.length), encrypted.cipherSizeBytes)
  assert.equal(new TextDecoder().decode(cipher).includes('private-report.txt'), false)

  const metadata = await decryptVaultMetadata(encrypted.envelope.encryptedMetadata, encrypted.envelope.keyWrap, encrypted.envelope.salt, { passphrase: 'correct horse battery staple' })
  assert.equal(metadata.name, 'private-report.txt')
  const restored = concat(await collect(await decryptVaultStream(new ReadableStream({ start(controller) { controller.enqueue(cipher); controller.close() } }), encrypted.envelope.keyWrap, encrypted.envelope.salt, { recoveryKey: encrypted.recoveryKey })))
  assert.deepEqual(restored, plain)
  await assert.rejects(decryptVaultMetadata(encrypted.envelope.encryptedMetadata, encrypted.envelope.keyWrap, encrypted.envelope.salt, { passphrase: 'wrong passphrase' }))
})

test('vault rejects changed and truncated ciphertext', async () => {
  const encrypted = await encryptVaultStream(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('integrity')); controller.close() } }), 'correct horse battery staple', {
    name: 'test.bin', mimeType: 'application/octet-stream', sizeBytes: 9, createdAt: '2026-11-18T00:00:00.000Z',
  })
  const cipher = concat(await collect(encrypted.stream))
  const changed = cipher.slice()
  changed[changed.length - 1] ^= 1
  await assert.rejects(async () => collect(await decryptVaultStream(new ReadableStream({ start(controller) { controller.enqueue(changed); controller.close() } }), encrypted.envelope.keyWrap, encrypted.envelope.salt, { passphrase: 'correct horse battery staple' })))
  await assert.rejects(async () => collect(await decryptVaultStream(new ReadableStream({ start(controller) { controller.enqueue(cipher.slice(0, -2)); controller.close() } }), encrypted.envelope.keyWrap, encrypted.envelope.salt, { passphrase: 'correct horse battery staple' })))
})

test('vault stream compacts arbitrary source chunks into bounded authenticated records', async () => {
  const plain = new Uint8Array(300_123).map((_byte, index) => index % 251)
  const encrypted = await encryptVaultStream(new ReadableStream({ start(controller) { for (let offset = 0; offset < plain.length; offset += 997) controller.enqueue(plain.subarray(offset, offset + 997)); controller.close() } }), 'correct horse battery staple', {
    name: 'large.bin', mimeType: 'application/octet-stream', sizeBytes: plain.length, createdAt: '2026-11-18T00:00:00.000Z',
  })
  const ciphertext = concat(await collect(encrypted.stream))
  assert.equal(BigInt(ciphertext.length), encrypted.cipherSizeBytes)
  const restored = concat(await collect(await decryptVaultStream(new ReadableStream({ start(controller) { controller.enqueue(ciphertext); controller.close() } }), encrypted.envelope.keyWrap, encrypted.envelope.salt, { passphrase: 'correct horse battery staple' })))
  assert.deepEqual(restored, plain)
})
