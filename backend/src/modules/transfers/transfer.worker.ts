import { createHash, randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { prisma } from '../../config/prisma.js'
import { storageProvider } from '../storage-providers/provider.js'
import { assertTransferJobTransition } from './transfer-state.js'
import { createReplicationRun } from './replication-run.js'
import { REPLICATION_SCHEDULES, nextReplicationRun, type ReplicationSchedule } from './replication-schedule.js'
import { HttpError } from '../../middleware/error.middleware.js'
import { providerRetryAfterMs } from './transfer-retry.js'

const LEASE_MS = 120_000
const IDLE_MS = 1_500
type ClaimedJob = { id: string; fencing_token: bigint }

export async function scheduleDueReplication() {
  let duePlanId: string | null = null
  try {
    await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM replication_plans
        WHERE status = 'active' AND schedule_cron IS NOT NULL AND next_run_at <= NOW(3)
        ORDER BY next_run_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`
      if (!rows.length) return
      duePlanId = rows[0].id
      const plan = await tx.replicationPlan.findUniqueOrThrow({ where: { id: duePlanId } })
      if (!REPLICATION_SCHEDULES.includes(plan.scheduleCron as ReplicationSchedule)) throw new HttpError(400, 'INVALID_REPLICATION_SCHEDULE', 'Replication schedule is invalid.')
      const active = await tx.transferJob.count({ where: { replicationPlanId: plan.id, status: { in: ['queued', 'running', 'cancelling'] } } })
      if (active) {
        await tx.replicationPlan.update({ where: { id: plan.id }, data: { nextRunAt: nextReplicationRun(plan.scheduleCron as ReplicationSchedule, new Date()) } })
        return
      }
      await createReplicationRun(tx, plan)
      await tx.replicationPlan.update({ where: { id: plan.id }, data: { nextRunAt: nextReplicationRun(plan.scheduleCron as ReplicationSchedule, new Date()) } })
    }, { timeout: 30_000 })
  } catch (error) {
    // A broken plan must not spin the scheduler or block other due plans.
    if (duePlanId && error instanceof HttpError) await prisma.replicationPlan.updateMany({ where: { id: duePlanId, status: 'active', nextRunAt: { lte: new Date() } }, data: { status: 'paused' } })
    console.error('[transfer-worker] scheduled replication failed', { planId: duePlanId, message: error instanceof Error ? error.message : String(error) })
  }
}

export async function claimNextJob(workerId: string) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<ClaimedJob[]>`
      SELECT id, fencing_token FROM transfer_jobs
      WHERE (status = 'queued' AND available_at <= NOW(3))
         OR (status IN ('running', 'cancelling') AND lease_expires_at < NOW(3))
      ORDER BY priority DESC, available_at ASC, created_at ASC
      LIMIT 1 FOR UPDATE SKIP LOCKED`
    const claimed = rows[0]
    if (!claimed) return null
    const job = await tx.transferJob.findUniqueOrThrow({ where: { id: claimed.id } })
    if (job.status === 'queued') assertTransferJobTransition(job.status, 'running')
    const updated = await tx.transferJob.update({
      where: { id: job.id },
      data: {
        status: job.status === 'cancelling' ? 'cancelling' : 'running', leaseOwner: workerId,
        leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        fencingToken: { increment: 1 }, attemptCount: { increment: 1 },
        startedAt: job.startedAt ?? new Date(),
      },
    })
    return { id: updated.id, fencingToken: updated.fencingToken }
  })
}

async function isCurrentLease(jobId: string, workerId: string, fencingToken: bigint, allowCancellation = false) {
  return (await prisma.transferJob.count({ where: { id: jobId, status: allowCancellation ? { in: ['running', 'cancelling'] } : 'running', leaseOwner: workerId, fencingToken, leaseExpiresAt: { gt: new Date() }, ...(allowCancellation ? {} : { cancelRequestedAt: null }) } })) === 1
}

async function processItem(jobId: string, itemId: string, workerId: string, fencingToken: bigint) {
  const item = await prisma.transferJobItem.findUniqueOrThrow({
    where: { id: itemId }, include: { sourceFile: { include: { connectedAccount: true, vaultObject: true } }, job: { include: { destinationConnectedAccount: true } } },
  })
  if (item.status === 'completed') return
  if (!(await isCurrentLease(jobId, workerId, fencingToken))) return
  if (item.sourceFile.providerFileId !== item.sourceProviderId || item.sourceFile.sizeBytes !== item.sizeBytes) throw new Error('Source file changed after this transfer was queued.')
  if (item.sourceFile.status !== 'active' && !(item.job.kind === 'move' && item.sourceFile.status === 'moved' && item.destinationFileId)) throw new Error('Source file is no longer available for transfer.')

  const sourceProvider = storageProvider(item.sourceFile.provider)
  const destinationProvider = storageProvider(item.job.destinationConnectedAccount.provider)
  const source = { ...item.sourceFile, connectedAccount: item.sourceFile.connectedAccount }
  const copyVaultEnvelope = async (destinationFileId: string) => {
    const encrypted = item.sourceFile.vaultObject
    if (!encrypted) return
    await prisma.vaultObject.upsert({
      where: { fileId: destinationFileId },
      create: { userId: item.job.userId, fileId: destinationFileId, formatVersion: encrypted.formatVersion, encryptedMetadata: encrypted.encryptedMetadata, salt: encrypted.salt, keyWrap: encrypted.keyWrap, encryptionAlgorithm: encrypted.encryptionAlgorithm },
      update: { formatVersion: encrypted.formatVersion, encryptedMetadata: encrypted.encryptedMetadata, salt: encrypted.salt, keyWrap: encrypted.keyWrap, encryptionAlgorithm: encrypted.encryptionAlgorithm },
    })
  }
  const recordReplication = async (destinationProviderId: string, checksum: string | null) => {
    if (!item.job.replicationPlanId) return
    await prisma.replicationMapping.upsert({
      where: { planId_sourceProviderId: { planId: item.job.replicationPlanId, sourceProviderId: item.sourceProviderId } },
      create: { planId: item.job.replicationPlanId, sourceProviderId: item.sourceProviderId, destinationProviderId, sourceVersion: item.sourceFile.updatedAt.toISOString(), checksum, lastReplicatedAt: new Date() },
      update: { destinationProviderId, sourceVersion: item.sourceFile.updatedAt.toISOString(), checksum, lastReplicatedAt: new Date() },
    })
  }
  if (item.destinationFileId && item.destinationProviderId) {
    const recorded = await prisma.file.findFirst({ where: { id: item.destinationFileId, userId: item.job.userId, connectedAccountId: item.job.destinationConnectedAccountId, providerFileId: item.destinationProviderId, status: 'active' }, include: { connectedAccount: true } })
    if (!recorded) throw new Error('Recorded destination file is missing; source will not be deleted.')
    await copyVaultEnvelope(recorded.id)
    if (item.job.kind === 'move' && item.sourceFile.status === 'active') {
      const remote = await destinationProvider.openDownload(recorded)
      const verifiedHash = createHash('sha256')
      let verifiedBytes = 0n
      for await (const chunk of remote) {
        verifiedHash.update(chunk)
        verifiedBytes += BigInt(chunk.length)
        if (verifiedBytes > item.sizeBytes) throw new Error('Destination file is larger than expected; source will not be deleted.')
      }
      if (verifiedBytes !== item.sizeBytes || !item.checksum || verifiedHash.digest('hex') !== item.checksum) {
        throw new Error('Destination integrity verification failed; source will not be deleted.')
      }
    }
    await recordReplication(item.destinationProviderId, item.checksum)
    if (item.job.kind === 'move' && item.sourceFile.status === 'active') {
      if (!(await isCurrentLease(jobId, workerId, fencingToken))) return
      await sourceProvider.deleteFile(source)
      await prisma.file.updateMany({ where: { id: item.sourceFileId, status: 'active' }, data: { status: 'moved', deletedAt: new Date(), deletedBySync: false } })
    }
    if (!(await isCurrentLease(jobId, workerId, fencingToken))) return
    await prisma.transferJobItem.update({ where: { id: item.id }, data: { status: 'completed', completedAt: new Date() } })
    return
  }
  const hash = createHash('sha256')
  let bytes = 0n
  const counted = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += BigInt(chunk.length)
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  const download = await sourceProvider.openDownload(source)
  download.on('error', (error) => counted.destroy(error))
  download.pipe(counted)
  const destination = await destinationProvider.uploadStream({
    userId: item.job.userId,
    account: item.job.destinationConnectedAccount,
    fileId: item.destinationFileId ?? item.id,
    name: item.destinationName,
    mimeType: item.sourceFile.mimeType,
    sizeBytes: item.sizeBytes,
    body: counted,
  })
  const digest = hash.digest('hex')
  if (bytes !== item.sizeBytes || destination.confirmedSizeBytes !== item.sizeBytes) {
    throw new Error(`Transfer integrity check failed: read ${bytes}, stored ${destination.confirmedSizeBytes}, expected ${item.sizeBytes} bytes.`)
  }
  if (!(await isCurrentLease(jobId, workerId, fencingToken))) return

  const destinationFileId = item.destinationFileId ?? randomUUID()
  const file = await prisma.file.upsert({
    where: { id: destinationFileId },
    create: {
      id: destinationFileId, userId: item.job.userId,
      connectedAccountId: item.job.destinationConnectedAccountId,
      provider: item.job.destinationConnectedAccount.provider,
      providerFileId: destination.providerFileId, name: item.destinationName,
      mimeType: item.sourceFile.mimeType, sizeBytes: item.sizeBytes, checksum: digest,
    },
    update: { providerFileId: destination.providerFileId, status: 'active', deletedAt: null, checksum: digest },
  })
  await copyVaultEnvelope(file.id)
  await prisma.transferJobItem.update({
    where: { id: item.id },
    data: { status: 'uploaded', destinationProviderId: destination.providerFileId, destinationFileId: file.id, checksum: digest, bytesTransferred: bytes, lastError: null },
  })
  await recordReplication(destination.providerFileId, digest)

  // A move is destructive only after destination bytes and metadata have been confirmed and
  // the worker still owns the current fenced lease.
  if (item.job.kind === 'move') {
    if (!(await isCurrentLease(jobId, workerId, fencingToken))) return
    await sourceProvider.deleteFile(source)
    await prisma.file.updateMany({ where: { id: item.sourceFileId, status: 'active' }, data: { status: 'moved', deletedAt: new Date(), deletedBySync: false } })
  }
  if (!(await isCurrentLease(jobId, workerId, fencingToken))) return
  await prisma.transferJobItem.update({ where: { id: item.id }, data: { status: 'completed', completedAt: new Date() } })
}

async function runClaimedJob(jobId: string, workerId: string, fencingToken: bigint) {
  let providerRetryDelayMs = 0
  const heartbeat = setInterval(() => {
    void prisma.transferJob.updateMany({
      where: { id: jobId, status: { in: ['running', 'cancelling'] }, leaseOwner: workerId, fencingToken },
      data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
    }).catch((error) => console.error('[transfer-worker] heartbeat failed', error instanceof Error ? error.message : error))
  }, Math.floor(LEASE_MS / 3))
  heartbeat.unref()
  try {
    const items = await prisma.transferJobItem.findMany({ where: { jobId, status: { in: ['queued', 'failed', 'running', 'uploaded'] } }, orderBy: { createdAt: 'asc' } })
    for (const item of items) {
      if (!(await isCurrentLease(jobId, workerId, fencingToken))) break
      await prisma.transferJobItem.update({ where: { id: item.id }, data: { status: 'running', attemptCount: { increment: 1 }, lastError: null } })
      try {
        await processItem(jobId, item.id, workerId, fencingToken)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Transfer failed.'
        providerRetryDelayMs = Math.max(providerRetryDelayMs, providerRetryAfterMs(error) ?? 0)
        await prisma.transferJobItem.update({ where: { id: item.id }, data: { status: 'failed', lastError: message.slice(0, 2000) } }).catch(() => undefined)
      }
    }
    const [completedItems, failedItems, totalItems, job] = await Promise.all([
      prisma.transferJobItem.count({ where: { jobId, status: 'completed' } }),
      prisma.transferJobItem.count({ where: { jobId, status: 'failed' } }),
      prisma.transferJobItem.count({ where: { jobId } }),
      prisma.transferJob.findUniqueOrThrow({ where: { id: jobId } }),
    ])
    if (!(await isCurrentLease(jobId, workerId, fencingToken, true))) return
    const status = job.cancelRequestedAt ? 'cancelled' : failedItems === 0 ? 'completed' : completedItems > 0 ? 'partial' : job.attemptCount >= job.maxAttempts ? 'dead_letter' : 'queued'
    assertTransferJobTransition(job.status, status)
    await prisma.transferJob.updateMany({
      where: { id: jobId, status: job.status, leaseOwner: workerId, fencingToken },
      data: { status, completedItems, failedItems, totalItems, lastError: failedItems ? 'One or more transfer items failed.' : null, completedAt: ['completed', 'cancelled', 'dead_letter'].includes(status) ? new Date() : null, leaseOwner: null, leaseExpiresAt: null, ...(status === 'queued' ? { availableAt: new Date(Date.now() + Math.max(Math.min(60_000, 1_000 * 2 ** job.attemptCount), providerRetryDelayMs)) } : {}) },
    })
  } finally {
    clearInterval(heartbeat)
  }
}

export async function runTransferWorker(options: { once?: boolean; workerId?: string } = {}) {
  const workerId = options.workerId ?? `worker-${process.pid}`
  do {
    await scheduleDueReplication()
    const job = await claimNextJob(workerId)
    if (!job) {
      if (options.once) return
      await new Promise((resolve) => setTimeout(resolve, IDLE_MS))
      continue
    }
    await runClaimedJob(job.id, workerId, job.fencingToken).catch(async (error) => {
      const message = error instanceof Error ? error.message : 'Worker failure.'
      await prisma.transferJob.updateMany({
        where: { id: job.id, status: { in: ['running', 'cancelling'] }, leaseOwner: workerId, fencingToken: job.fencingToken },
        data: { status: 'failed', lastError: message.slice(0, 2000), leaseOwner: null, leaseExpiresAt: null },
      })
      console.error('[transfer-worker] job failed', { jobId: job.id, message })
    })
    if (options.once) return
  } while (true)
}
