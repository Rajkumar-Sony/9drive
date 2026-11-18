import assert from 'node:assert/strict'
import test from 'node:test'

process.env.DATABASE_URL ??= 'mysql://test:test@127.0.0.1:3306/driveconnect_test'
process.env.FRONTEND_URL ??= 'http://localhost:5173'
process.env.JWT_ACCESS_SECRET ??= 'test-only-jwt-signing-secret-at-least-32-characters'
process.env.TOKEN_ENCRYPTION_KEY ??= 'test-only-token-encryption-key-at-least-32-chars'

test('storage providers declare upload limits and operation capabilities', async () => {
  const { storageProvider } = await import('../dist/modules/storage-providers/provider.js')
  const google = storageProvider('google_drive')
  const s3 = storageProvider('s3')

  assert.equal(google.capabilities.maxUploadBytes, 5_000_000_000_000n)
  assert.equal(google.capabilities.resumableUpload, true)
  assert.equal(google.capabilities.multipartUpload, false)
  assert.equal(google.capabilities.createFolder, true)
  assert.equal(google.capabilities.download, true)
  assert.equal(s3.capabilities.maxUploadBytes, null)
  assert.equal(s3.capabilities.resumableUpload, true)
  assert.equal(s3.capabilities.multipartUpload, true)
  assert.equal(s3.capabilities.createFolder, false)
  assert.equal(s3.capabilities.download, true)
  const oneDrive = storageProvider('onedrive')
  assert.equal(oneDrive.capabilities.maxUploadBytes, 250_000_000_000n)
})

test('capability guard rejects unsupported provider operations', async () => {
  const { assertProviderCapability } = await import('../dist/modules/storage-providers/provider.js')
  const s3 = (await import('../dist/modules/storage-providers/provider.js')).storageProvider('s3')
  assert.throws(() => assertProviderCapability(s3, 'createFolder'), /does not support createFolder/)
  assert.doesNotThrow(() => assertProviderCapability(s3, 'download'))
})
