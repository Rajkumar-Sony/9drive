import assert from 'node:assert/strict'
import test from 'node:test'

test('transfer retry scheduling honors provider flood-wait durations and bounds them', async () => {
  const { providerRetryAfterMs } = await import('../dist/modules/transfers/transfer-retry.js')
  assert.equal(providerRetryAfterMs({ retryAfterSeconds: 42 }), 42_000)
  assert.equal(providerRetryAfterMs({ seconds: '75' }), 75_000)
  assert.equal(providerRetryAfterMs({ cause: { retry_after: 7200 } }), 3_600_000)
  assert.equal(providerRetryAfterMs(new Error('temporary network error')), null)
})
