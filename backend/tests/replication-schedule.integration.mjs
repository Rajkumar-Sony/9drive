import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../dist/config/prisma.js'
import { scheduleDueReplication } from '../dist/modules/transfers/transfer.worker.js'

const testId = randomUUID()
const user = await prisma.user.create({ data: { name: 'Replication scheduler test', email: `scheduler-${testId}@example.invalid`, passwordHash: 'test-only' } })
try {
  const source = await prisma.connectedAccount.create({ data: { userId: user.id, provider: 'google_drive', providerAccountId: `scheduler-source-${testId}`, email: 'source@example.invalid', scopes: [] } })
  const destination = await prisma.connectedAccount.create({ data: { userId: user.id, provider: 's3', providerAccountId: `scheduler-destination-${testId}`, email: 'destination@example.invalid', scopes: [] } })
  const plan = await prisma.replicationPlan.create({ data: { userId: user.id, name: 'Concurrent scheduling check', sourceConnectedAccountId: source.id, destinationConnectedAccountId: destination.id, scheduleCron: '0 * * * *', nextRunAt: new Date(Date.now() - 60_000) } })

  await Promise.all([scheduleDueReplication(), scheduleDueReplication()])
  const jobs = await prisma.transferJob.findMany({ where: { replicationPlanId: plan.id } })
  const advanced = await prisma.replicationPlan.findUniqueOrThrow({ where: { id: plan.id } })
  assert.equal(jobs.length, 1, 'two schedulers must create exactly one run')
  assert.equal(jobs[0].status, 'completed', 'an empty source has no transfer work')
  assert.ok(advanced.nextRunAt && advanced.nextRunAt.getTime() > Date.now(), 'schedule must advance')
  await prisma.connectedAccount.update({ where: { id: source.id }, data: { status: 'disconnected' } })
  await prisma.replicationPlan.update({ where: { id: plan.id }, data: { nextRunAt: new Date(Date.now() - 60_000) } })
  await scheduleDueReplication()
  const paused = await prisma.replicationPlan.findUniqueOrThrow({ where: { id: plan.id } })
  assert.equal(paused.status, 'paused', 'a plan with a disconnected account must stop scheduling')
  assert.equal(await prisma.transferJob.count({ where: { replicationPlanId: plan.id } }), 1)
  console.log('Concurrent replication scheduling passed.')
} finally {
  await prisma.transferJob.deleteMany({ where: { userId: user.id } })
  await prisma.replicationPlan.deleteMany({ where: { userId: user.id } })
  await prisma.connectedAccount.deleteMany({ where: { userId: user.id } })
  await prisma.user.delete({ where: { id: user.id } })
  await prisma.$disconnect()
}
