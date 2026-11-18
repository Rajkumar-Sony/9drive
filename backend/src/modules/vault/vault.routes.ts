import { Router } from 'express'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'

export const vaultRouter = Router()
vaultRouter.use(requireAuth)

// The API returns encrypted metadata and ciphertext locations only. Decryption always happens in
// the user's browser; this route intentionally has no passphrase or recovery-key fields.
vaultRouter.get('/objects', async (req: AuthRequest, res, next) => {
  try {
    const objects = await prisma.vaultObject.findMany({
      where: { userId: req.user!.id, file: { userId: req.user!.id, status: 'active' } },
      include: { file: { select: { id: true, name: true, sizeBytes: true, provider: true, createdAt: true, status: true } } },
      orderBy: { createdAt: 'desc' },
    })
    return res.json({ objects: objects.map((object) => ({
      fileId: object.fileId,
      name: object.file.name,
      sizeBytes: object.file.sizeBytes.toString(),
      provider: object.file.provider,
      createdAt: object.createdAt,
      formatVersion: object.formatVersion,
      encryptedMetadata: Buffer.from(object.encryptedMetadata).toString('base64url'),
      salt: Buffer.from(object.salt).toString('base64url'),
      keyWrap: Buffer.from(object.keyWrap).toString('utf8'),
      encryptionAlgorithm: object.encryptionAlgorithm,
    })) })
  } catch (error) { return next(error) }
})
