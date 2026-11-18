import type { Prisma, ReplicationPlan } from '../../generated/prisma/client.js'
import { HttpError } from '../../middleware/error.middleware.js'
import { storageProvider } from '../storage-providers/provider.js'

export async function createReplicationRun(tx: Prisma.TransactionClient, plan: ReplicationPlan) {
  const accounts = await tx.connectedAccount.findMany({ where: { id: { in: [plan.sourceConnectedAccountId, plan.destinationConnectedAccountId] }, userId: plan.userId, status: 'connected' } })
  const source = accounts.find((account) => account.id === plan.sourceConnectedAccountId)
  const destination = accounts.find((account) => account.id === plan.destinationConnectedAccountId)
  if (!source || !destination) throw new HttpError(409, 'ACCOUNT_DISCONNECTED', 'Reconnect both accounts before running this plan.')
  if (!storageProvider(source.provider).capabilities.download || !storageProvider(destination.provider).capabilities.upload) {
    throw new HttpError(409, 'PROVIDER_OPERATION_UNAVAILABLE', 'The connected providers cannot complete this replication.')
  }

  const alreadyRunning = await tx.transferJob.count({ where: { replicationPlanId: plan.id, status: { in: ['queued', 'running', 'cancelling'] } } })
  if (alreadyRunning) throw new HttpError(409, 'REPLICATION_ALREADY_RUNNING', 'This replication plan already has an active run.')
  const files = await tx.file.findMany({ where: { userId: plan.userId, connectedAccountId: source.id, status: 'active' }, orderBy: { id: 'asc' }, take: 1001 })
  if (files.length > 1000) throw new HttpError(409, 'REPLICATION_TOO_LARGE', 'This plan has more than 1,000 files; batch support is required before running it.')

  const mappings = await tx.replicationMapping.findMany({ where: { planId: plan.id }, select: { sourceProviderId: true, sourceVersion: true, destinationProviderId: true } })
  const destinationIds = mappings.map((mapping) => mapping.destinationProviderId)
  const destinationFiles = destinationIds.length ? await tx.file.findMany({ where: { userId: plan.userId, connectedAccountId: destination.id, providerFileId: { in: destinationIds }, status: 'active' }, select: { providerFileId: true } }) : []
  const existingDestinations = new Set(destinationFiles.map((file) => file.providerFileId))
  const versions = new Map(mappings.filter((mapping) => existingDestinations.has(mapping.destinationProviderId)).map((mapping) => [mapping.sourceProviderId, mapping.sourceVersion]))
  const pending = files.filter((file) => versions.get(file.providerFileId) !== file.updatedAt.toISOString())
  const maxUpload = storageProvider(destination.provider).capabilities.maxUploadBytes
  if (maxUpload !== null && pending.some((file) => file.sizeBytes > maxUpload)) throw new HttpError(409, 'PROVIDER_FILE_TOO_LARGE', 'A source file exceeds the destination provider limit.')

  const job = await tx.transferJob.create({ data: { userId: plan.userId, kind: 'replicate', replicationPlanId: plan.id, sourceConnectedAccountId: source.id, destinationConnectedAccountId: destination.id, status: pending.length ? 'queued' : 'completed', completedAt: pending.length ? null : new Date(), totalItems: pending.length, items: { create: pending.map((file) => ({ sourceFileId: file.id, sourceProviderId: file.providerFileId, destinationName: file.name, sizeBytes: file.sizeBytes })) } } })
  await tx.replicationPlan.update({ where: { id: plan.id }, data: { lastRunAt: new Date() } })
  return job
}
