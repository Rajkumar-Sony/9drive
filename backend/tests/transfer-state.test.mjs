import assert from 'node:assert/strict'
import test from 'node:test'

process.env.DATABASE_URL ??= 'mysql://test:test@127.0.0.1:3306/driveconnect_test'
process.env.FRONTEND_URL ??= 'http://localhost:5173'
process.env.JWT_ACCESS_SECRET ??= 'test-only-jwt-signing-secret-at-least-32-characters'
process.env.TOKEN_ENCRYPTION_KEY ??= 'test-only-token-encryption-key-at-least-32-chars'

test('transfer job state machine allows recoverable pause and retry paths', async () => {
  const { canTransitionTransferJob } = await import('../dist/modules/transfers/transfer-state.js')
  assert.equal(canTransitionTransferJob('queued', 'running'), true)
  assert.equal(canTransitionTransferJob('running', 'paused'), true)
  assert.equal(canTransitionTransferJob('failed', 'queued'), true)
  assert.equal(canTransitionTransferJob('dead_letter', 'queued'), true)
})

test('transfer job state machine rejects unsafe terminal and cross-state transitions', async () => {
  const { canTransitionTransferJob, assertTransferJobTransition, terminalTransferStatus } = await import('../dist/modules/transfers/transfer-state.js')
  assert.equal(canTransitionTransferJob('completed', 'queued'), false)
  assert.equal(canTransitionTransferJob('cancelled', 'running'), false)
  assert.throws(() => assertTransferJobTransition('completed', 'queued'), /Invalid transfer job transition/)
  assert.equal(terminalTransferStatus('completed'), true)
  assert.equal(terminalTransferStatus('partial'), false)
})
