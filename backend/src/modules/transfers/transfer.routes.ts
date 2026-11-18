import { Router } from 'express'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { storageProvider, assertProviderCapability } from '../storage-providers/provider.js'
import { assertTransferJobTransition } from './transfer-state.js'
import { keepBothName } from './conflict-name.js'
import { createReplicationRun } from './replication-run.js'
import { REPLICATION_SCHEDULES, nextReplicationRun } from './replication-schedule.js'

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
  scheduleCron: z.enum(REPLICATION_SCHEDULES).nullable().default(null),
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
    const plan = await prisma.replicationPlan.create({ data: { userId: req.user!.id, name: body.name, sourceConnectedAccountId: source.id, destinationConnectedAccountId: destination.id, scheduleCron: body.scheduleCron, nextRunAt: body.scheduleCron ? nextReplicationRun(body.scheduleCron, new Date()) : null } })
    return res.status(201).json({ plan })
  } catch (error) { return next(error) }
})

transferRouter.get('/plans', async (req: AuthRequest, res, next) => {
  try {
    const plans = await prisma.replicationPlan.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' }, take: 100 })
    return res.json({ plans })
  } catch (error) { return next(error) }
})

transferRouter.patch('/plans/:id/schedule', async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({ scheduleCron: z.enum(REPLICATION_SCHEDULES).nullable() }).parse(req.body)
    const result = await prisma.replicationPlan.updateMany({ where: { id: String(req.params.id), userId: req.user!.id }, data: { scheduleCron: body.scheduleCron, nextRunAt: body.scheduleCron ? nextReplicationRun(body.scheduleCron, new Date()) : null, status: 'active' } })
    if (!result.count) return res.status(404).json({ code: 'REPLICATION_PLAN_NOT_FOUND', message: 'Replication plan not found.' })
    const plan = await prisma.replicationPlan.findUniqueOrThrow({ where: { id: String(req.params.id) } })
    return res.json({ plan })
  } catch (error) { return next(error) }
})

transferRouter.post('/plans/:id/run', async (req: AuthRequest, res, next) => {
  try {
    const job = await prisma.$transaction(async (tx) => {
      const id = String(req.params.id)
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM replication_plans WHERE id = ${id} AND user_id = ${req.user!.id} AND status IN ('active', 'paused') FOR UPDATE`
      if (!locked.length) return null
      const plan = await tx.replicationPlan.findUniqueOrThrow({ where: { id } })
      return createReplicationRun(tx, plan)
    }, { timeout: 30_000 })
    if (!job) return res.status(404).json({ code: 'REPLICATION_PLAN_NOT_FOUND', message: 'Replication plan not found.' })
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
    const maxUpload = storageProvider(destination.provider).capabilities.maxUploadBytes
    if (maxUpload !== null && files.some((file) => file.sizeBytes > maxUpload)) return res.status(400).json({ code: 'PROVIDER_FILE_TOO_LARGE', message: 'A source file exceeds the destination provider limit.' })
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
    const nextStatus = action === 'resume' || action === 'retry' ? 'queued' : action === 'cancel' ? job.status === 'running' ? 'cancelling' : 'cancelled' : 'paused'
    assertTransferJobTransition(job.status, nextStatus)
    const result = await prisma.transferJob.updateMany({ where: { id: job.id, userId: req.user!.id, status: job.status, fencingToken: job.fencingToken }, data: {
      status: nextStatus, ...(nextStatus === 'queued' ? { availableAt: new Date(), cancelRequestedAt: null, leaseOwner: null, leaseExpiresAt: null } : {}),
      ...(['cancelled', 'cancelling'].includes(nextStatus) ? { cancelRequestedAt: new Date() } : {}),
    } })
    if (result.count !== 1) return res.status(409).json({ code: 'TRANSFER_STATE_CHANGED', message: 'Transfer changed while this action was requested. Refresh and retry.' })
    const updated = await prisma.transferJob.findUniqueOrThrow({ where: { id: job.id } })
    return res.json({ job: { ...updated, fencingToken: updated.fencingToken.toString() } })
  } catch (error) { return next(error) }
})
