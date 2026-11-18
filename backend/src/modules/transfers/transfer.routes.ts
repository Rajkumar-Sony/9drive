import { Router } from 'express'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { storageProvider, assertProviderCapability } from '../storage-providers/provider.js'
import { assertTransferJobTransition } from './transfer-state.js'
import { keepBothName } from './conflict-name.js'

export const transferRouter = Router()
transferRouter.use(requireAuth)

const createSchema = z.object({
  kind: z.enum(['copy', 'move', 'replicate']),
  sourceAccountId: z.string().uuid(),
  destinationAccountId: z.string().uuid(),
  fileIds: z.array(z.string().uuid()).min(1).max(100),
  conflictPolicy: z.literal('keep_both').default('keep_both'),
})

const replicationPlanSchema = z.object({
  name: z.string().trim().min(1).max(191),
  sourceAccountId: z.string().uuid(),
  destinationAccountId: z.string().uuid(),
})

transferRouter.post('/plans', async (req: AuthRequest, res, next) => {
  try {
    const body = replicationPlanSchema.parse(req.body)
    if (body.sourceAccountId === body.destinationAccountId) return res.status(400).json({ code: 'SAME_ACCOUNT', message: 'Choose a different destination account.' })
    const accounts = await prisma.connectedAccount.findMany({ where: { id: { in: [body.sourceAccountId, body.destinationAccountId] }, userId: req.user!.id, status: 'connected' } })
    const source = accounts.find((account) => account.id === body.sourceAccountId)
    const destination = accounts.find((account) => account.id === body.destinationAccountId)
    if (!source || !destination) return res.status(404).json({ code: 'ACCOUNT_NOT_FOUND', message: 'Source or destination account was not found.' })
    assertProviderCapability(storageProvider(source.provider), 'download')
    assertProviderCapability(storageProvider(destination.provider), 'upload')
    const plan = await prisma.replicationPlan.create({ data: { userId: req.user!.id, name: body.name, sourceConnectedAccountId: source.id, destinationConnectedAccountId: destination.id } })
    return res.status(201).json({ plan })
  } catch (error) { return next(error) }
})

transferRouter.get('/plans', async (req: AuthRequest, res, next) => {
  try {
    const plans = await prisma.replicationPlan.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' }, take: 100 })
    return res.json({ plans })
  } catch (error) { return next(error) }
})

transferRouter.post('/plans/:id/run', async (req: AuthRequest, res, next) => {
  try {
    const plan = await prisma.replicationPlan.findFirst({ where: { id: String(req.params.id), userId: req.user!.id, status: 'active' } })
    if (!plan) return res.status(404).json({ code: 'REPLICATION_PLAN_NOT_FOUND', message: 'Replication plan not found.' })
    const accounts = await prisma.connectedAccount.findMany({ where: { id: { in: [plan.sourceConnectedAccountId, plan.destinationConnectedAccountId] }, userId: req.user!.id, status: 'connected' } })
    const source = accounts.find((account) => account.id === plan.sourceConnectedAccountId)
    const destination = accounts.find((account) => account.id === plan.destinationConnectedAccountId)
    if (!source || !destination) return res.status(409).json({ code: 'ACCOUNT_DISCONNECTED', message: 'Reconnect both accounts before running this plan.' })
    assertProviderCapability(storageProvider(source.provider), 'download')
    assertProviderCapability(storageProvider(destination.provider), 'upload')
    const alreadyRunning = await prisma.transferJob.count({ where: { userId: req.user!.id, kind: 'replicate', sourceConnectedAccountId: plan.sourceConnectedAccountId, destinationConnectedAccountId: plan.destinationConnectedAccountId, status: { in: ['queued', 'running'] } } })
    if (alreadyRunning) return res.status(409).json({ code: 'REPLICATION_ALREADY_RUNNING', message: 'A replication between these accounts is already running.' })
    const files = await prisma.file.findMany({ where: { userId: req.user!.id, connectedAccountId: plan.sourceConnectedAccountId, status: 'active' }, orderBy: { id: 'asc' }, take: 1001 })
    if (files.length > 1000) return res.status(409).json({ code: 'REPLICATION_TOO_LARGE', message: 'This plan has more than 1,000 files; batch support is required before running it.' })
    const mappings = await prisma.replicationMapping.findMany({ where: { planId: plan.id }, select: { sourceProviderId: true, sourceVersion: true, destinationProviderId: true } })
    const destinationIds = mappings.map((mapping) => mapping.destinationProviderId)
    const destinationFiles = await prisma.file.findMany({ where: { userId: req.user!.id, connectedAccountId: plan.destinationConnectedAccountId, providerFileId: { in: destinationIds }, status: 'active' }, select: { providerFileId: true } })
    const existingDestinations = new Set(destinationFiles.map((file) => file.providerFileId))
    const versions = new Map(mappings.filter((mapping) => existingDestinations.has(mapping.destinationProviderId)).map((mapping) => [mapping.sourceProviderId, mapping.sourceVersion]))
    const pending = files.filter((file) => versions.get(file.providerFileId) !== file.updatedAt.toISOString())
    const job = await prisma.transferJob.create({ data: { userId: req.user!.id, kind: 'replicate', replicationPlanId: plan.id, sourceConnectedAccountId: plan.sourceConnectedAccountId, destinationConnectedAccountId: plan.destinationConnectedAccountId, status: pending.length ? 'queued' : 'completed', completedAt: pending.length ? null : new Date(), totalItems: pending.length, items: { create: pending.map((file) => ({ sourceFileId: file.id, sourceProviderId: file.providerFileId, destinationName: file.name, sizeBytes: file.sizeBytes })) } } })
    await prisma.replicationPlan.update({ where: { id: plan.id }, data: { lastRunAt: new Date() } })
    return res.status(201).json({ job: { ...job, fencingToken: job.fencingToken.toString() } })
  } catch (error) { return next(error) }
})

transferRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const body = createSchema.parse(req.body)
    if (body.sourceAccountId === body.destinationAccountId) return res.status(400).json({ code: 'SAME_ACCOUNT', message: 'Choose a different destination account.' })
    const accounts = await prisma.connectedAccount.findMany({ where: { id: { in: [body.sourceAccountId, body.destinationAccountId] }, userId: req.user!.id, status: 'connected' } })
    const source = accounts.find((account) => account.id === body.sourceAccountId)
    const destination = accounts.find((account) => account.id === body.destinationAccountId)
    if (!source || !destination) return res.status(404).json({ code: 'ACCOUNT_NOT_FOUND', message: 'Source or destination account was not found.' })
    assertProviderCapability(storageProvider(source.provider), 'download')
    assertProviderCapability(storageProvider(destination.provider), 'upload')
    const ids = [...new Set(body.fileIds)]
    const files = await prisma.file.findMany({ where: { id: { in: ids }, userId: req.user!.id, connectedAccountId: source.id, status: 'active' } })
    if (files.length !== ids.length) return res.status(400).json({ code: 'FILES_NOT_FOUND', message: 'Every selected file must belong to the source account.' })
    const existingNames = new Set((await prisma.file.findMany({ where: { userId: req.user!.id, connectedAccountId: destination.id, status: 'active' }, select: { name: true } })).map((file) => file.name))
    const items = files.map((file) => {
      const name = keepBothName(file.name, existingNames)
      existingNames.add(name)
      return { id: randomUUID(), sourceFileId: file.id, sourceProviderId: file.providerFileId, destinationName: name, sizeBytes: file.sizeBytes }
    })
    const job = await prisma.transferJob.create({ data: {
      userId: req.user!.id, kind: body.kind, sourceConnectedAccountId: source.id,
      destinationConnectedAccountId: destination.id, conflictPolicy: body.conflictPolicy,
      totalItems: items.length, items: { create: items },
    } })
    return res.status(201).json({ job: { ...job, fencingToken: job.fencingToken.toString() } })
  } catch (error) { return next(error) }
})

transferRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const jobs = await prisma.transferJob.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' }, take: 50, include: { items: { select: { id: true, status: true, destinationName: true, bytesTransferred: true, lastError: true } } } })
    return res.json({ jobs: jobs.map((job) => ({ ...job, fencingToken: job.fencingToken.toString(), items: job.items.map((item) => ({ ...item, bytesTransferred: item.bytesTransferred.toString() })) })) })
  } catch (error) { return next(error) }
})

transferRouter.get('/:id/events', async (req: AuthRequest, res, next) => {
  try {
    const jobId = z.string().uuid().parse(req.params.id)
    const exists = await prisma.transferJob.count({ where: { id: jobId, userId: req.user!.id } })
    if (!exists) return res.status(404).json({ code: 'TRANSFER_NOT_FOUND', message: 'Transfer not found.' })
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    let closed = false
    let previous = ''
    const emit = async () => {
      if (closed) return
      const job = await prisma.transferJob.findFirst({ where: { id: jobId, userId: req.user!.id }, select: { id: true, status: true, totalItems: true, completedItems: true, failedItems: true, updatedAt: true, items: { select: { id: true, status: true, bytesTransferred: true, lastError: true } } } })
      if (!job) { res.end(); return }
      const payload = JSON.stringify({ ...job, items: job.items.map((item) => ({ ...item, bytesTransferred: item.bytesTransferred.toString() })) })
      if (payload !== previous) { previous = payload; res.write(`event: progress\ndata: ${payload}\n\n`) }
      else res.write(': keepalive\n\n')
      if (['completed', 'cancelled', 'dead_letter'].includes(job.status)) res.end()
    }
    await emit()
    const timer = setInterval(() => { void emit().catch(() => { clearInterval(timer); res.end() }) }, 2000)
    req.on('close', () => { closed = true; clearInterval(timer) })
  } catch (error) { return next(error) }
})

transferRouter.post('/:id/:action', async (req: AuthRequest, res, next) => {
  try {
    const action = z.enum(['pause', 'resume', 'cancel', 'retry']).parse(req.params.action)
    const job = await prisma.transferJob.findFirst({ where: { id: String(req.params.id), userId: req.user!.id } })
    if (!job) return res.status(404).json({ code: 'TRANSFER_NOT_FOUND', message: 'Transfer not found.' })
    const nextStatus = action === 'resume' || action === 'retry' ? 'queued' : action === 'cancel' ? 'cancelled' : 'paused'
    assertTransferJobTransition(job.status, nextStatus)
    const result = await prisma.transferJob.updateMany({ where: { id: job.id, userId: req.user!.id, status: job.status, fencingToken: job.fencingToken }, data: {
      status: nextStatus, ...(nextStatus === 'queued' ? { availableAt: new Date(), cancelRequestedAt: null, leaseOwner: null, leaseExpiresAt: null } : {}),
      ...(nextStatus === 'cancelled' ? { cancelRequestedAt: new Date() } : {}),
    } })
    if (result.count !== 1) return res.status(409).json({ code: 'TRANSFER_STATE_CHANGED', message: 'Transfer changed while this action was requested. Refresh and retry.' })
    const updated = await prisma.transferJob.findUniqueOrThrow({ where: { id: job.id } })
    return res.json({ job: { ...updated, fencingToken: updated.fencingToken.toString() } })
  } catch (error) { return next(error) }
})
