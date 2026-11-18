import assert from 'node:assert/strict'
import test from 'node:test'
import { nextReplicationRun } from '../dist/modules/transfers/replication-schedule.js'

test('UTC schedules always advance across day and week boundaries', () => {
  const friday = new Date('2026-11-20T23:59:59.000Z')
  assert.equal(nextReplicationRun('0 * * * *', friday).toISOString(), '2026-11-21T00:00:00.000Z')
  assert.equal(nextReplicationRun('0 0 * * *', friday).toISOString(), '2026-11-21T00:00:00.000Z')
  assert.equal(nextReplicationRun('0 0 * * 1', friday).toISOString(), '2026-11-23T00:00:00.000Z')
})
