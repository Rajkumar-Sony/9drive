import assert from 'node:assert/strict'
import test from 'node:test'

process.env.DATABASE_URL ??= 'mysql://test:test@127.0.0.1:3306/driveconnect_test'
process.env.FRONTEND_URL ??= 'http://localhost:5173'
process.env.JWT_ACCESS_SECRET ??= 'test-only-jwt-signing-secret-at-least-32-characters'
process.env.TOKEN_ENCRYPTION_KEY ??= 'test-only-token-encryption-key-at-least-32-chars'

test('copy requires a downloadable source and uploadable destination', async () => {
  const { assertTransferCapabilities } = await import('../dist/modules/transfers/transfer-capabilities.js')
  const source = { type: 'telegram_bot', capabilities: { download: true, delete: false } }
  const destination = { type: 's3', capabilities: { upload: true } }

  assert.doesNotThrow(() => assertTransferCapabilities(source, destination, 'copy'))
  assert.throws(() => assertTransferCapabilities({ ...source, capabilities: { download: false } }, destination, 'copy'), { code: 'PROVIDER_OPERATION_UNAVAILABLE' })
  assert.throws(() => assertTransferCapabilities(source, { type: 'telegram_mtproto', capabilities: { upload: false } }, 'copy'), { code: 'PROVIDER_OPERATION_UNAVAILABLE' })
})

test('move is rejected unless the source provider can delete reliably', async () => {
  const { assertTransferCapabilities } = await import('../dist/modules/transfers/transfer-capabilities.js')
  const destination = { type: 's3', capabilities: { upload: true } }

  assert.throws(() => assertTransferCapabilities({ type: 'telegram_bot', capabilities: { download: true, delete: false } }, destination, 'move'), { code: 'PROVIDER_OPERATION_UNAVAILABLE' })
  assert.doesNotThrow(() => assertTransferCapabilities({ type: 'onedrive', capabilities: { download: true, delete: true } }, destination, 'move'))
})

test('unavailable provider downloads fail before an adapter is opened', async () => {
  const { assertProviderCapability } = await import('../dist/modules/storage-providers/provider.js')
  assert.throws(
    () => assertProviderCapability({ type: 'telegram_bot', capabilities: { download: false } }, 'download'),
    { status: 409, code: 'PROVIDER_OPERATION_UNAVAILABLE' },
  )
})
