import { Router } from 'express'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { storageProvider, assertProviderCapability } from '../storage-providers/provider.js'
import { assertTransferJobTransition } from './transfer-state.js'

export const transferRouter = Router()
transferRouter.use(requireAuth)

const createSchema = z.object({
  kind: z.enum(['copy', 'move', 'replicate']),
  sourceAccountId: z.string().uuid(),
  destinationAccountId: z.string().uuid(),
  fileIds: z.array(z.string().uuid()).min(1).max(100),
  conflictPolicy: z.literal('keep_both').default('keep_both'),
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
      let name = file.name
      if (existingNames.has(name)) {
        const dot = name.lastIndexOf('.')
        const stem = dot > 0 ? name.slice(0, dot) : name
        const ext = dot > 0 ? name.slice(dot) : ''
        let index = 2
        do { name = `${stem} (${index++})${ext}`.slice(0, 255) } while (existingNames.has(name))
      }
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

transferRouter.post('/:id/:action', async (req: AuthRequest, res, next) => {
  try {
    const action = z.enum(['pause', 'resume', 'cancel', 'retry']).parse(req.params.action)
    const job = await prisma.transferJob.findFirst({ where: { id: String(req.params.id), userId: req.user!.id } })
    if (!job) return res.status(404).json({ code: 'TRANSFER_NOT_FOUND', message: 'Transfer not found.' })
    const nextStatus = action === 'resume' || action === 'retry' ? 'queued' : action === 'cancel' ? 'cancelled' : 'paused'
    assertTransferJobTransition(job.status, nextStatus)
    const updated = await prisma.transferJob.update({ where: { id: job.id }, data: {
      status: nextStatus, ...(nextStatus === 'queued' ? { availableAt: new Date(), cancelRequestedAt: null, leaseOwner: null, leaseExpiresAt: null } : {}),
      ...(nextStatus === 'cancelled' ? { cancelRequestedAt: new Date() } : {}),
    } })
    return res.json({ job: { ...updated, fencingToken: updated.fencingToken.toString() } })
  } catch (error) { return next(error) }
})
