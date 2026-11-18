import assert from 'node:assert/strict'
import test from 'node:test'

process.env.DATABASE_URL ??= 'mysql://test:test@127.0.0.1:3306/driveconnect_test'
process.env.FRONTEND_URL ??= 'http://localhost:5173'
process.env.JWT_ACCESS_SECRET ??= 'test-only-jwt-signing-secret-at-least-32-characters'
process.env.TOKEN_ENCRYPTION_KEY ??= 'test-only-token-encryption-key-at-least-32-chars'

test('OneDrive delta pagination accepts only Microsoft Graph drive URLs', async () => {
  const { oneDriveDeltaUrl } = await import('../dist/modules/onedrive/onedrive.service.js')
  assert.equal(oneDriveDeltaUrl('/me/drive/root/delta'), 'https://graph.microsoft.com/v1.0/me/drive/root/delta')
  assert.equal(oneDriveDeltaUrl('https://graph.microsoft.com/v1.0/me/drive/root/delta?token=abc'), 'https://graph.microsoft.com/v1.0/me/drive/root/delta?token=abc')
  for (const url of ['https://graph.microsoft.com.evil.test/v1.0/me/drive/root/delta', 'http://graph.microsoft.com/v1.0/me/drive/root/delta', 'https://graph.microsoft.com/v1.0/users/me']) assert.throws(() => oneDriveDeltaUrl(url))
})
