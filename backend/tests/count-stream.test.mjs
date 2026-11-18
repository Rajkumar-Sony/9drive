import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

test('countStreamBytes forwards streams within the limit and stops forwarding overflow', async () => {
  const { countStreamBytes } = await import('../dist/utils/count-stream.js')
  const { HttpError } = await import('../dist/middleware/error.middleware.js')
  const input = Readable.from([Buffer.from('123'), Buffer.from('456')])
  const counted = countStreamBytes(input, 5n, new HttpError(413, 'TOO_LARGE', 'too large'))
  const output = []
  counted.stream.on('data', (chunk) => output.push(chunk))
  const completed = new Promise((resolve, reject) => {
    counted.stream.once('end', resolve)
    counted.stream.once('error', reject)
  })
  await assert.rejects(completed, { status: 413, code: 'TOO_LARGE' })
  assert.equal(counted.bytes(), 3n)
  assert.deepEqual(Buffer.concat(output).toString(), '123')
})
