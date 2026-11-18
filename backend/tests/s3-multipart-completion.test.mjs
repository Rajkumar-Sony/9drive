import assert from 'node:assert/strict'
import test from 'node:test'

test('multipart completion claims uploading sessions and recovers only after the completion lease expires', async () => {
  const { mayClaimMultipartCompletion } = await import('../dist/utils/s3-multipart.js')
  const now = new Date('2026-11-18T00:00:30.000Z')
  assert.equal(mayClaimMultipartCompletion('uploading', null, now), true)
  assert.equal(mayClaimMultipartCompletion('completing', new Date('2026-11-18T00:00:31.000Z'), now), false)
  assert.equal(mayClaimMultipartCompletion('completing', new Date('2026-11-18T00:00:30.000Z'), now), true)
  assert.equal(mayClaimMultipartCompletion('completing', null, now), true)
  assert.equal(mayClaimMultipartCompletion('completed', null, now), false)
})
