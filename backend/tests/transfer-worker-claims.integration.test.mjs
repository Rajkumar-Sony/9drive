// Uses a dedicated scratch MySQL database. Never point this at the application's working database.
// Run after migrations with TRANSFER_TEST_DATABASE_URL set to that scratch database URL.
import assert from 'node:assert/strict'
import test from 'node:test'

const DB = process.env.TRANSFER_TEST_DATABASE_URL
const skip = !DB && 'TRANSFER_TEST_DATABASE_URL not set'
let prisma
let claimNextJob
let user
let source
let destination

test.before(async () => {
  if (skip) return
  process.env.DATABASE_URL = DB
  ;({ prisma } = await import('../dist/config/prisma.js'))
  ;({ claimNextJob } = await import('../dist/modules/transfers/transfer.worker.js'))
  user = await prisma.user.create({ data: { name: 'Worker claim test', email: `worker-claims-${crypto.randomUUID()}@example.invalid`, passwordHash: 'test-only' } })
  source = await prisma.connectedAccount.create({ data: { userId: user.id, provider: 'google_drive', providerAccountId: 'source', email: 'source@example.invalid', scopes: [], status: 'connected' } })
  destination = await prisma.connectedAccount.create({ data: { userId: user.id, provider: 's3', providerAccountId: 'destination', email: 'destination@example.invalid', scopes: [], status: 'connected' } })
})

test.after(async () => {
  if (!skip && prisma) {
    if (user) {
      await prisma.transferJob.deleteMany({ where: { userId: user.id } })
      await prisma.connectedAccount.deleteMany({ where: { userId: user.id } })
      await prisma.user.deleteMany({ where: { id: user.id } })
    }
    await prisma.$disconnect()
  }
})

test('concurrent workers claim separate jobs and expired leases are reclaimed with fencing', { skip }, async () => {
  const jobs = await Promise.all(Array.from({ length: 12 }, (_, index) => prisma.transferJob.create({
    data: {
      userId: user.id,
      kind: 'copy',
      sourceConnectedAccountId: source.id,
      destinationConnectedAccountId: destination.id,
      totalItems: 0,
      lastError: `claim-test-${index}`,
    },
  })))

  const claims = await Promise.all(Array.from({ length: jobs.length }, async (_, index) => {
    for (let retry = 0; retry < 100; retry++) {
      const claim = await claimNextJob(`parallel-worker-${index}`)
      if (claim) return claim
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return null
  }))
  assert.equal(claims.length, jobs.length)
  assert.ok(claims.every(Boolean))
  assert.equal(new Set(claims.map((claim) => claim.id)).size, jobs.length)
  assert.ok(claims.every((claim) => claim.fencingToken === 1n))

  const crashJob = await prisma.transferJob.create({
    data: { userId: user.id, kind: 'copy', sourceConnectedAccountId: source.id, destinationConnectedAccountId: destination.id, totalItems: 0, lastError: 'claim-test-crash' },
  })
  const firstClaim = await claimNextJob('worker-before-crash')
  assert.ok(firstClaim)
  assert.equal(firstClaim.id, crashJob.id)
  await prisma.transferJob.update({ where: { id: crashJob.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } })

  const recovered = await claimNextJob('worker-after-crash')
  assert.deepEqual(recovered, { id: crashJob.id, fencingToken: 2n })
  const row = await prisma.transferJob.findUniqueOrThrow({ where: { id: crashJob.id } })
  assert.equal(row.leaseOwner, 'worker-after-crash')
  assert.equal(row.attemptCount, 2)
})
