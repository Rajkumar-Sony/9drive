import crypto from 'node:crypto'
import type { FileShare } from '../../generated/prisma/client.js'
import type { Request, Response } from 'express'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { HttpError } from '../../middleware/error.middleware.js'
import { hashToken } from '../../utils/crypto.js'
import { verifyPassword } from '../../utils/password.js'

const COOKIE_PREFIX = 'share_access_'
const GRANT_SECONDS = 12 * 60 * 60
const WINDOW_MS = 15 * 60 * 1000
const MAX_ATTEMPTS = 5
const signingKey = crypto.createHash('sha256').update(`share-access:${env.TOKEN_ENCRYPTION_KEY}`).digest()

function cookieName(share: FileShare): string {
  return `${COOKIE_PREFIX}${share.id.replace(/-/g, '')}`
}

function cookieValue(req: Request, share: FileShare): string | undefined {
  const prefix = `${cookieName(share)}=`
  return req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length)
}

function sign(value: string): string {
  return crypto.createHmac('sha256', signingKey).update(value).digest('base64url')
}

function validGrant(req: Request, share: FileShare): boolean {
  const raw = cookieValue(req, share)
  if (!raw) return false
  const [payload, signature] = raw.split('.')
  if (!payload || !signature) return false
  const expected = sign(payload)
  const given = Buffer.from(signature, 'utf8')
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, Buffer.from(expected))) return false
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { id?: string; version?: number; exp?: number }
    return data.id === share.id && data.version === share.passwordVersion && typeof data.exp === 'number' && data.exp > Date.now()
  } catch {
    return false
  }
}

export function requireShareAccess(req: Request, share: FileShare) {
  if (share.passwordHash && !validGrant(req, share)) {
    throw new HttpError(401, 'SHARE_PASSWORD_REQUIRED', 'This shared file requires a password.')
  }
}

export async function unlockShare(req: Request, res: Response, share: FileShare, password: string) {
  if (!share.passwordHash) throw new HttpError(400, 'SHARE_NOT_PROTECTED', 'This link does not require a password.')
  const keyHash = hashToken(`${share.id}:${req.ip ?? 'unknown'}`)
  const now = new Date()
  if (Math.random() < 0.01) {
    await prisma.sharePasswordAttempt.deleteMany({ where: { resetAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } } }).catch(() => undefined)
  }
  // One atomic MySQL statement prevents concurrent guesses from losing increments.
  const resetAt = new Date(now.getTime() + WINDOW_MS)
  await prisma.$executeRaw`
    INSERT INTO share_password_attempts (key_hash, count, reset_at)
    VALUES (${keyHash}, 1, ${resetAt})
    ON DUPLICATE KEY UPDATE
      count = IF(reset_at <= ${now}, 1, count + 1),
      reset_at = IF(reset_at <= ${now}, ${resetAt}, reset_at)
  `
  const attempt = await prisma.sharePasswordAttempt.findUniqueOrThrow({ where: { keyHash } })
  if (attempt.count > MAX_ATTEMPTS) throw new HttpError(429, 'SHARE_UNLOCK_LIMIT', 'Too many attempts. Try again later.')
  if (!(await verifyPassword(share.passwordHash, password))) throw new HttpError(401, 'SHARE_PASSWORD_INVALID', 'Incorrect password.')

  await prisma.sharePasswordAttempt.delete({ where: { keyHash } }).catch(() => undefined)
  const maxAge = Math.max(0, Math.min(GRANT_SECONDS * 1000, (share.expiresAt?.getTime() ?? Infinity) - Date.now()))
  const payload = Buffer.from(JSON.stringify({ id: share.id, version: share.passwordVersion, exp: Date.now() + maxAge })).toString('base64url')
  res.cookie(cookieName(share), `${payload}.${sign(payload)}`, {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'lax',
    // The web deployment can publish this router under /api/public; Path=/ works
    // for both that proxy and direct local requests. The signed grant remains share-scoped.
    path: '/',
    maxAge,
  })
}
