import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../dist/config/prisma.js'
import { encryptText, decryptText } from '../dist/utils/crypto.js'
import { syncOneDriveFiles } from '../dist/modules/onedrive/onedrive-sync.js'

const testId = randomUUID()
const user = await prisma.user.create({ data: { name: 'OneDrive discovery test', email: `onedrive-sync-${testId}@example.invalid`, passwordHash: 'test-only' } })
const originalFetch = globalThis.fetch
let phase = 0
globalThis.fetch = async (input) => {
  const url = new URL(String(input))
  assert.equal(url.origin, 'https://graph.microsoft.com')
  if (url.pathname.endsWith('/root/delta')) {
    const value = phase === 0
      ? [
          { id: 'folder-A', name: 'Photos', folder: {}, parentReference: { id: 'root-A' } },
          { id: 'file-A', name: 'portrait.jpg', size: 5, eTag: 'v1', file: { mimeType: 'image/jpeg' }, parentReference: { id: 'folder-A' } },
        ]
      : phase === 1
        ? [{ id: 'file-A', name: 'portrait-new.jpg', size: 5, eTag: 'v2', file: { mimeType: 'image/jpeg' }, parentReference: { id: 'folder-A' } }]
        : [{ id: 'file-A', deleted: {} }]
    return Response.json({ value, '@odata.deltaLink': `https://graph.microsoft.com/v1.0/me/drive/root/delta?token=${phase}` })
  }
  if (url.pathname.endsWith('/root')) return Response.json({ id: 'root-A' })
  throw new Error(`Unexpected Graph request path: ${url.pathname}`)
}

try {
  const config = await prisma.providerConfig.create({ data: { userId: user.id, provider: 'onedrive', clientIdEncrypted: encryptText('client'), clientSecretEncrypted: encryptText('secret'), redirectUri: 'http://localhost/callback', scopes: ['Files.ReadWrite', 'offline_access'] } })
  const account = await prisma.connectedAccount.create({ data: { userId: user.id, providerConfigId: config.id, provider: 'onedrive', providerAccountId: `test-${testId}`, email: 'drive@example.invalid', scopes: ['Files.ReadWrite'], accessTokenEncrypted: encryptText('token'), refreshTokenEncrypted: encryptText('refresh'), tokenExpiresAt: new Date(Date.now() + 3_600_000) } })
  await syncOneDriveFiles(account.id, user.id)
  const first = await prisma.file.findFirstOrThrow({ where: { connectedAccountId: account.id, providerFileId: 'file-A' } })
  const folder = await prisma.folder.findUniqueOrThrow({ where: { id: first.folderId } })
  assert.equal(folder.name, 'Photos')
  assert.equal(first.providerVersion, 'v1')
  const cursor = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: account.id } })
  assert.ok(cursor.oneDriveDeltaLinkEncrypted && !cursor.oneDriveDeltaLinkEncrypted.includes('token=0'))
  assert.match(decryptText(cursor.oneDriveDeltaLinkEncrypted), /token=0/)

  phase = 1
  await syncOneDriveFiles(account.id, user.id)
  const second = await prisma.file.findUniqueOrThrow({ where: { id: first.id } })
  assert.equal(second.name, 'portrait-new.jpg')
  assert.equal(second.providerVersion, 'v2')

  phase = 2
  await syncOneDriveFiles(account.id, user.id)
  const removed = await prisma.file.findUniqueOrThrow({ where: { id: first.id } })
  assert.equal(removed.status, 'deleted')
  assert.equal(removed.deletedBySync, true)
  console.log('OneDrive discovery and delta reconciliation passed.')
} finally {
  globalThis.fetch = originalFetch
  await prisma.file.deleteMany({ where: { userId: user.id } })
  await prisma.folder.deleteMany({ where: { userId: user.id } })
  await prisma.connectedAccount.deleteMany({ where: { userId: user.id } })
  await prisma.providerConfig.deleteMany({ where: { userId: user.id } })
  await prisma.user.delete({ where: { id: user.id } })
  await prisma.$disconnect()
}
