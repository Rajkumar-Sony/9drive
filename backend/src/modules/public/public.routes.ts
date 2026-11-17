import { Router } from 'express'
import { prisma } from '../../config/prisma.js'
import { HttpError } from '../../middleware/error.middleware.js'
import { hashToken } from '../../utils/crypto.js'
import { streamProviderFile } from '../files/stream-file.js'
import { z } from 'zod'
import { requireShareAccess, unlockShare } from './share-access.js'

export const publicRouter = Router()

async function findSharedFile(token: string) {
  const share = await prisma.fileShare.findFirst({
    where: { tokenHash: hashToken(token), enabled: true, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    include: { file: { include: { connectedAccount: true } } },
  })
  if (!share || share.file.status !== 'active') throw new HttpError(404, 'SHARE_NOT_FOUND', 'Shared file not found.')
  return share
}

publicRouter.post('/files/:token/unlock', async (req, res, next) => {
  try {
    const token = String(req.params.token)
    const share = await findSharedFile(token)
    const { password } = z.object({ password: z.string().min(1).max(128) }).parse(req.body)
    await unlockShare(req, res, share, password)
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})

publicRouter.get('/files/:token', async (req, res, next) => {
  try {
    const share = await findSharedFile(String(req.params.token))
    requireShareAccess(req, share)
    const file = share.file
    return res.json({ file: { id: file.id, name: file.name, mimeType: file.mimeType, sizeBytes: file.sizeBytes.toString(), createdAt: file.createdAt, passwordProtected: Boolean(share.passwordHash) } })
  } catch (error) {
    return next(error)
  }
})

publicRouter.get('/files/:token/download', async (req, res, next) => {
  try {
    const share = await findSharedFile(String(req.params.token))
    requireShareAccess(req, share)
    const file = share.file
    return streamProviderFile(file, req.headers.range, res, { disposition: 'attachment' })
  } catch (error) {
    return next(error)
  }
})

publicRouter.get('/files/:token/preview', async (req, res, next) => {
  try {
    const share = await findSharedFile(String(req.params.token))
    requireShareAccess(req, share)
    const file = share.file
    return streamProviderFile(file, req.headers.range, res, { disposition: 'inline' })
  } catch (error) {
    return next(error)
  }
})
