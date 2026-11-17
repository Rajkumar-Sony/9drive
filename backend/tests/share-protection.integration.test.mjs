import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

test('share password owner and public API flow', { skip: !process.env.SHARE_LIVE_TEST }, async () => {
  const { prisma } = await import('../dist/config/prisma.js')
  const { signAccessToken } = await import('../dist/utils/jwt.js')
  const { hashToken } = await import('../dist/utils/crypto.js')
  const suffix = crypto.randomUUID()
  const base = process.env.SHARE_TEST_API_URL ?? 'http://127.0.0.1:4000'
  let userId, otherUserId, shareId
  const request = (path, options = {}) => fetch(`${base}${path}`, options)
  const post = (path, body, headers = {}) => request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  try {
    const user = await prisma.user.create({ data: { name: 'Share test', email: `share-${suffix}@example.invalid`, passwordHash: 'fixture-only' } })
    userId = user.id
    const session = await prisma.userSession.create({ data: { userId, refreshTokenHash: `fixture-${suffix}`, expiresAt: new Date(Date.now() + 60000) } })
    const auth = { Authorization: `Bearer ${signAccessToken({ sub: userId, sid: session.id })}` }
    const account = await prisma.connectedAccount.create({ data: { userId, provider: 's3', providerAccountId: `fixture-${suffix}`, email: 'fixture@example.invalid', scopes: [] } })
    const file = await prisma.file.create({ data: { userId, connectedAccountId: account.id, provider: 's3', providerFileId: `fixture-${suffix}`, name: 'test.txt', mimeType: 'text/plain', sizeBytes: 1n } })
    const owner = `/files/${file.id}/share`
    const other = await prisma.user.create({ data: { name: 'Other user', email: `share-other-${suffix}@example.invalid`, passwordHash: 'fixture-only' } })
    otherUserId = other.id
    const otherSession = await prisma.userSession.create({ data: { userId: other.id, refreshTokenHash: `fixture-other-${suffix}`, expiresAt: new Date(Date.now() + 60000) } })
    const otherAuth = { Authorization: `Bearer ${signAccessToken({ sub: other.id, sid: otherSession.id })}` }
    assert.equal((await post(owner, { expiresIn: 'never' })).status, 401)
    assert.equal((await post(owner, { password: 'short' }, auth)).status, 400)
    assert.equal((await post(owner, { password: 'other password 2026' }, otherAuth)).status, 404)
    const opened = await post(owner, { expiresIn: '7d' }, auth)
    assert.equal(opened.status, 201)
    const initial = await opened.json()
    shareId = initial.shareId
    const publicPath = `/public/files/${new URL(initial.url).pathname.split('/').at(-1)}`
    assert.equal((await request(publicPath)).status, 200)
    const protectedResponse = await post(owner, { password: 'first password 2026' }, auth)
    assert.equal(protectedResponse.status, 200)
    const protectedLink = await protectedResponse.json()
    assert.equal(protectedLink.url, initial.url)
    assert.equal(protectedLink.expiresAt, initial.expiresAt)
    for (const path of ['', '/preview', '/download']) {
      const response = await request(publicPath + path)
      assert.equal(response.status, 401)
      assert.equal((await response.json()).code, 'SHARE_PASSWORD_REQUIRED')
    }
    assert.equal((await post(`${publicPath}/unlock`, { password: 'wrong' })).status, 401)
    const unlocked = await post(`${publicPath}/unlock`, { password: 'first password 2026' })
    assert.equal(unlocked.status, 200)
    const cookie = unlocked.headers.get('set-cookie')?.split(';')[0]
    assert.match(cookie ?? '', /^share_access_/)
    const metadata = await request(publicPath, { headers: { Cookie: cookie } })
    assert.equal(metadata.status, 200)
    assert.equal((await metadata.json()).file.passwordProtected, true)
    assert.equal((await post(owner, { password: 'second password 2026' }, auth)).status, 200)
    assert.equal((await request(publicPath, { headers: { Cookie: cookie } })).status, 401)
    assert.equal((await post(`${publicPath}/unlock`, { password: 'first password 2026' })).status, 401)
    assert.equal((await post(`${publicPath}/unlock`, { password: 'second password 2026' })).status, 200)
    const removed = await post(owner, { password: null }, auth)
    assert.equal((await removed.json()).passwordProtected, false)
    assert.equal((await request(publicPath)).status, 200)
    await post(owner, { password: 'third password 2026' }, auth)
    const concurrentAttempts = await Promise.all(Array.from({ length: 10 }, () => post(`${publicPath}/unlock`, { password: 'wrong' })))
    assert.equal(concurrentAttempts.filter((response) => response.status === 401).length, 5)
    assert.equal(concurrentAttempts.filter((response) => response.status === 429).length, 5)
    assert.equal((await concurrentAttempts.find((response) => response.status === 429).json()).code, 'SHARE_UNLOCK_LIMIT')
  } finally {
    if (shareId) await prisma.sharePasswordAttempt.deleteMany({ where: { keyHash: hashToken(`${shareId}:127.0.0.1`) } }).catch(() => undefined)
    if (userId) await prisma.user.delete({ where: { id: userId } })
    if (otherUserId) await prisma.user.delete({ where: { id: otherUserId } })
    await prisma.$disconnect()
  }
})
