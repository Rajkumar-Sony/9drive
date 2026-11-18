import assert from 'node:assert/strict'
import test from 'node:test'

test('telegram document identifiers are bounded, unambiguous, and validated', async () => {
  const { parseBotDocumentId, serializeBotDocumentId } = await import('../dist/modules/telegram/bot-api.js')
  const id = serializeBotDocumentId({ messageId: 123, fileId: 'CAACAgIAAxkBAA-example_id' })

  assert.deepEqual(parseBotDocumentId(id), { messageId: 123, fileId: 'CAACAgIAAxkBAA-example_id' })
  assert.throws(() => parseBotDocumentId('not-a-telegram-file-id'), /invalid/i)
  assert.throws(() => serializeBotDocumentId({ messageId: 0, fileId: '' }), /invalid/i)
})

test('bot API validates server-configured endpoints and permits HTTP only in explicit local mode', async () => {
  const { normalizeBotApiBaseUrl } = await import('../dist/modules/telegram/bot-api.js')

  assert.equal(normalizeBotApiBaseUrl(undefined), 'https://api.telegram.org')
  assert.equal(normalizeBotApiBaseUrl('http://telegram-api:8081', true), 'http://telegram-api:8081')
  assert.throws(() => normalizeBotApiBaseUrl('http://example.com', false), /https/i)
  assert.throws(() => normalizeBotApiBaseUrl('https://user:pass@example.com', true), /credentials/i)
})

test('multipart document upload streams bytes and rejects mismatched upstream size', async () => {
  const { TelegramBotApi } = await import('../dist/modules/telegram/bot-api.js')
  let bodyText = ''
  let redirectMode
  const api = new TelegramBotApi('123456:'.padEnd(45, 'x'), 'https://api.telegram.org', async (_url, init) => {
    redirectMode = init.redirect
    for await (const chunk of init.body) bodyText += Buffer.from(chunk).toString('binary')
    return new Response(JSON.stringify({ ok: true, result: { message_id: 12, document: { file_id: 'remote-file', file_size: 5 } } }), { headers: { 'content-type': 'application/json' } })
  })

  await assert.rejects(api.sendDocument({ chatId: '12345', name: 'sample.txt', mimeType: 'text/plain', sizeBytes: 4n, body: (async function* () { yield Buffer.from('data') })() }), /size/i)
  assert.match(bodyText, /name="document"/)
  assert.match(bodyText, /data/)
  assert.equal(redirectMode, 'error')
  assert.throws(() => new TelegramBotApi('token/with?url=characters-xxxxxxxxxxxxxxxx', 'https://api.telegram.org'), /invalid/i)
})
