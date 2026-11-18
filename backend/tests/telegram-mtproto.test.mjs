import assert from 'node:assert/strict'
import test from 'node:test'

process.env.DATABASE_URL ??= 'mysql://test:test@127.0.0.1:3306/test'
process.env.FRONTEND_URL ??= 'http://localhost:5173'
process.env.JWT_ACCESS_SECRET ??= 'test-jwt-secret-at-least-32-characters-long'
process.env.TOKEN_ENCRYPTION_KEY ??= 'test-encryption-secret-at-least-32-chars'
import { SessionPasswordNeededError } from 'teleproto/errors'

test('MTProto login stores a session after code challenge and always disconnects', async () => {
  const { beginTelegramLogin } = await import('../dist/modules/telegram/mtproto.js')
  const calls = []
  const client = {
    session: { save: () => 'session-after-code' },
    connect: async () => calls.push('connect'),
    disconnect: async () => calls.push('disconnect'),
    sendCode: async (credentials, phone) => { calls.push([credentials.apiId, phone]); return { phoneCodeHash: 'private-code-hash', isCodeViaApp: true } },
  }

  const result = await beginTelegramLogin('+15551234567', () => client, { apiId: 7, apiHash: 'a'.repeat(24) })
  assert.deepEqual(result, { phoneCodeHash: 'private-code-hash', session: 'session-after-code', isCodeViaApp: true })
  assert.deepEqual(calls, ['connect', [7, '+15551234567'], 'disconnect'])
})

test('MTProto code verification can pause for 2FA and later complete without exposing session state', async () => {
  const { finishTelegramLogin } = await import('../dist/modules/telegram/mtproto.js')
  const makeClient = (shouldNeedPassword) => ({
    session: { save: () => 'session-current' },
    connect: async () => {},
    disconnect: async () => {},
    invoke: async () => { if (shouldNeedPassword) throw Object.create(SessionPasswordNeededError.prototype); return { id: 88, username: 'user' } },
    getMe: async () => ({ id: 88, username: 'user' }),
    signInWithPassword: async (_credentials, params) => { assert.equal(await params.password(), 'correct horse battery staple'); return { id: 88, username: 'user' } },
  })

  const passwordStep = await finishTelegramLogin({ session: 'first-session', phone: '+15551234567', phoneCodeHash: 'hash', code: '12345' }, () => makeClient(true), { apiId: 7, apiHash: 'a'.repeat(24) })
  assert.deepEqual(passwordStep, { status: 'password_required', session: 'session-current' })
  const complete = await finishTelegramLogin({ session: 'second-session', phone: '+15551234567', phoneCodeHash: 'hash', password: 'correct horse battery staple' }, () => makeClient(false), { apiId: 7, apiHash: 'a'.repeat(24) })
  assert.equal(complete.status, 'complete')
  assert.equal(complete.session, 'session-current')
  assert.equal(complete.user.id, 88)
})

test('MTProto upload partitioning keeps bounded chunks and verifies declared byte size', async () => {
  const { fixedSizeParts } = await import('../dist/modules/telegram/mtproto.js')
  const source = (async function* () { yield Buffer.from('abc'); yield Buffer.from('defgh') })()
  const parts = []
  for await (const part of fixedSizeParts(source, 4, 8n)) parts.push(Buffer.from(part).toString())
  assert.deepEqual(parts, ['abcd', 'efgh'])

  await assert.rejects(async () => {
    for await (const _part of fixedSizeParts((async function* () { yield Buffer.from('too much') })(), 4, 3n)) {}
  }, /exceeded/i)
  await assert.rejects(async () => {
    for await (const _part of fixedSizeParts((async function* () { yield Buffer.from('short') })(), 4, 6n)) {}
  }, /match/i)
})
