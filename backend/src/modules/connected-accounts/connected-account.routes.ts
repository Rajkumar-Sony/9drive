import { Router } from 'express'
import { google } from '../google/google-apis.js'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { removeImportedDrive, syncGoogleDriveInBackground } from '../google/drive-sync.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { createAuditLog } from '../../utils/audit.js'
import { accountLabel } from '../../utils/account-label.js'
import { encryptText, hashToken, randomToken } from '../../utils/crypto.js'
import { completeGoogleLogin } from '../auth/google-login.js'
import { createOAuthClient, syncGoogleQuota } from '../google/google.service.js'
import { assertSafeS3Endpoint, syncS3Quota, testS3Connection } from '../s3/s3.service.js'
import { storageProvider } from '../storage-providers/provider.js'
import { oauthClientSchema, oauthReturnUrl } from '../../utils/oauth-return.js'
import { exchangeOneDriveCode, oneDriveConnectUrl, syncOneDriveQuota } from '../onedrive/onedrive.service.js'
import { syncOneDriveFiles } from '../onedrive/onedrive-sync.js'
import { decryptText } from '../../utils/crypto.js'
import { telegramBotApi } from '../storage-providers/telegram-bot.provider.js'
import { HttpError } from '../../middleware/error.middleware.js'
import { beginTelegramLogin, finishTelegramLogin } from '../telegram/mtproto.js'

export const connectedAccountRouter = Router()

const s3ConnectSchema = z.object({
  name: z.string().trim().min(1).max(191),
  bucket: z.string().trim().min(1).max(191),
  region: z.string().trim().min(1).max(191),
  endpoint: z.string().url().optional().or(z.literal('')),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  forcePathStyle: z.boolean().optional(),
  quotaBytes: z.string().regex(/^\d+$/).optional().nullable(),
})

async function syncQuotaForAccount(account: { id: string; provider: string }) {
  const provider = storageProvider(account.provider)
  if (!provider.capabilities.quota) throw new HttpError(409, 'PROVIDER_QUOTA_UNAVAILABLE', 'This provider does not report storage quota.')
  return provider.syncQuota(account.id)
}

connectedAccountRouter.get('/', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const accounts = await prisma.connectedAccount.findMany({
      where: { userId: req.user!.id, status: 'connected' },
      include: { storageAccount: true },
      orderBy: { createdAt: 'desc' },
    })
    const missingQuota = accounts.filter((account) => storageProvider(account.provider).capabilities.quota && !account.storageAccount?.lastSyncedAt)
    for (const account of missingQuota) await syncQuotaForAccount(account).catch(() => undefined)

    const syncedAccounts = missingQuota.length > 0
      ? await prisma.connectedAccount.findMany({
        where: { userId: req.user!.id, status: 'connected' },
        include: { storageAccount: true },
        orderBy: { createdAt: 'desc' },
      })
      : accounts

    return res.json({
      accounts: syncedAccounts.map(({ accessTokenEncrypted: _a, refreshTokenEncrypted: _r, telegramSessionEncrypted: _t, storageAccount, ...account }) => ({
        ...account,
        storageAccount: storageAccount ? {
          ...storageAccount,
          totalBytes: storageAccount.totalBytes?.toString() ?? null,
          usedBytes: storageAccount.usedBytes.toString(),
          availableBytes: storageAccount.availableBytes?.toString() ?? null,
          trashBytes: storageAccount.trashBytes?.toString() ?? null,
        } : null,
      })),
    })
  } catch (error) {
    return next(error)
  }
})

async function createGoogleConnectUrl(req: AuthRequest) {
  const query = z.object({ providerConfigId: z.string().min(1).optional(), client: oauthClientSchema }).parse(req.query)
  const config = query.providerConfigId
    ? await prisma.providerConfig.findFirstOrThrow({ where: { id: query.providerConfigId, OR: [{ userId: req.user!.id }, { userId: null }], provider: 'google_drive', status: 'active' } })
    : await prisma.providerConfig.findFirstOrThrow({ where: { userId: null, provider: 'google_drive', status: 'active' }, orderBy: { createdAt: 'desc' } })
  const state = randomToken()
  await prisma.oauthState.create({ data: { userId: req.user!.id, providerConfigId: config.id, flow: 'connect', client: query.client, stateHash: hashToken(state), expiresAt: new Date(Date.now() + 10 * 60_000) } })
  const client = createOAuthClient(config)
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: config.scopes as string[],
    state,
  })
}

connectedAccountRouter.post('/s3', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = s3ConnectSchema.parse(req.body)
    if (body.endpoint) await assertSafeS3Endpoint(body.endpoint)
    const providerAccountId = `${body.bucket}:${body.endpoint || body.region}`
    const existingAccount = await prisma.connectedAccount.findUnique({ where: { userId_provider_providerAccountId: { userId: req.user!.id, provider: 's3', providerAccountId } } })
    const account = existingAccount
      ? await prisma.connectedAccount.update({
        where: { id: existingAccount.id },
        data: {
          providerConfigId: null,
          email: `${body.bucket} (S3)`,
          displayName: body.name,
          accessTokenEncrypted: encryptText('s3'),
          refreshTokenEncrypted: encryptText(randomToken()),
          tokenExpiresAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
          scopes: [],
          status: 'connected',
        },
      })
      : await prisma.connectedAccount.create({ data: {
        userId: req.user!.id,
        providerConfigId: null,
        provider: 's3',
        providerAccountId,
        email: `${body.bucket} (S3)`,
        displayName: body.name,
        accessTokenEncrypted: encryptText('s3'),
        refreshTokenEncrypted: encryptText(randomToken()),
        tokenExpiresAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
        scopes: [],
        status: 'connected',
      } })
    const config = await prisma.s3StorageConfig.upsert({
      where: { connectedAccountId: account.id },
      create: {
        userId: req.user!.id,
        connectedAccountId: account.id,
        name: body.name,
        bucket: body.bucket,
        region: body.region,
        endpoint: body.endpoint || null,
        accessKeyIdEncrypted: encryptText(body.accessKeyId),
        secretAccessKeyEncrypted: encryptText(body.secretAccessKey),
        forcePathStyle: body.forcePathStyle ?? Boolean(body.endpoint),
        quotaBytes: body.quotaBytes ? BigInt(body.quotaBytes) : null,
      },
      update: {
        name: body.name,
        bucket: body.bucket,
        region: body.region,
        endpoint: body.endpoint || null,
        accessKeyIdEncrypted: encryptText(body.accessKeyId),
        secretAccessKeyEncrypted: encryptText(body.secretAccessKey),
        forcePathStyle: body.forcePathStyle ?? Boolean(body.endpoint),
        quotaBytes: body.quotaBytes ? BigInt(body.quotaBytes) : null,
        status: 'active',
      },
    })
    try {
      await testS3Connection(config)
      const quota = await syncS3Quota(account.id)
      await createAuditLog(req.user!.id, 'CONNECT_ACCOUNT', 'account', account.id, { provider: 's3', accountLabel: accountLabel(account) })
      return res.status(201).json({
        account: {
          ...account,
          storageAccount: { ...quota, totalBytes: quota.totalBytes?.toString() ?? null, usedBytes: quota.usedBytes.toString(), availableBytes: quota.availableBytes?.toString() ?? null, trashBytes: quota.trashBytes?.toString() ?? null },
        },
      })
    } catch (error) {
      if (!existingAccount) await prisma.connectedAccount.delete({ where: { id: account.id } }).catch(() => undefined)
      throw error
    }
  } catch (error) {
    return next(error)
  }
})

connectedAccountRouter.post('/telegram/bot', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({ botToken: z.string().trim().regex(/^\d{5,15}:[A-Za-z0-9_-]{20,128}$/), chatId: z.string().trim().min(1).max(255) }).parse(req.body)
    const api = telegramBotApi(body.botToken)
    const [bot, chat] = await Promise.all([api.getMe(), api.getChat(body.chatId)])
    if (!Number.isSafeInteger(chat.id)) throw new HttpError(400, 'TELEGRAM_CHAT_INVALID', 'Telegram returned an invalid chat identifier.')
    const providerAccountId = String(chat.id)
    const email = `telegram-${bot.id}@bot.oneconnect`
    const displayName = `${bot.username ? `@${bot.username}` : bot.first_name || 'Telegram bot'} · ${chat.title || chat.username || chat.first_name || providerAccountId}`
    const account = await prisma.connectedAccount.upsert({
      where: { userId_provider_providerAccountId: { userId: req.user!.id, provider: 'telegram_bot', providerAccountId } },
      create: { userId: req.user!.id, provider: 'telegram_bot', providerAccountId, email, displayName, accessTokenEncrypted: encryptText(body.botToken), scopes: ['bot_api'], status: 'connected' },
      update: { email, displayName, accessTokenEncrypted: encryptText(body.botToken), status: 'connected', lastError: null },
    })
    await createAuditLog(req.user!.id, 'CONNECT_ACCOUNT', 'account', account.id, { provider: 'telegram_bot' })
    return res.status(201).json({ account: { id: account.id, provider: account.provider, email: account.email, displayName: account.displayName, status: account.status, createdAt: account.createdAt, storageAccount: null } })
  } catch (error) {
    return next(error)
  }
})

connectedAccountRouter.post('/telegram/mtproto/start', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { phone } = z.object({ phone: z.string().trim().min(9).max(16) }).parse(req.body)
    const activeChallenges = await prisma.telegramAuthChallenge.count({ where: { userId: req.user!.id, status: { in: ['awaiting_code', 'awaiting_password'] }, expiresAt: { gt: new Date() } } })
    if (activeChallenges >= 3) throw new HttpError(429, 'TELEGRAM_LOGIN_LIMIT', 'Finish or wait for an existing Telegram login attempt before starting another.')
    const login = await beginTelegramLogin(phone)
    const challenge = await prisma.telegramAuthChallenge.create({ data: {
      userId: req.user!.id,
      phoneEncrypted: encryptText(phone),
      phoneCodeHashEncrypted: encryptText(login.phoneCodeHash),
      sessionEncrypted: encryptText(login.session),
      status: 'awaiting_code',
      expiresAt: new Date(Date.now() + 10 * 60_000),
    } })
    return res.status(201).json({ challengeId: challenge.id, expiresAt: challenge.expiresAt, codeViaApp: Boolean(login.isCodeViaApp) })
  } catch (error) { return next(error) }
})

connectedAccountRouter.post('/telegram/mtproto/finish', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({ challengeId: z.string().uuid(), code: z.string().trim().min(4).max(12).optional(), password: z.string().min(1).max(256).optional() }).refine((value) => value.code || value.password, { message: 'Enter the Telegram code or two-step verification password.' }).parse(req.body)
    const challenge = await prisma.telegramAuthChallenge.findFirst({ where: { id: body.challengeId, userId: req.user!.id, status: { in: ['awaiting_code', 'awaiting_password'] }, expiresAt: { gt: new Date() }, attemptCount: { lt: 5 } } })
    if (!challenge) throw new HttpError(410, 'TELEGRAM_CHALLENGE_EXPIRED', 'This Telegram login attempt expired or reached its attempt limit. Start again.')
    const attempt = await prisma.telegramAuthChallenge.updateMany({ where: { id: challenge.id, userId: req.user!.id, status: challenge.status, attemptCount: challenge.attemptCount, expiresAt: { gt: new Date() } }, data: { attemptCount: { increment: 1 } } })
    if (attempt.count !== 1) throw new HttpError(409, 'TELEGRAM_CHALLENGE_BUSY', 'This login attempt changed. Please retry.')
    const result = await finishTelegramLogin({
      session: decryptText(challenge.sessionEncrypted),
      phone: decryptText(challenge.phoneEncrypted),
      phoneCodeHash: decryptText(challenge.phoneCodeHashEncrypted),
      code: body.code,
      password: body.password,
    })
    if (result.status === 'password_required') {
      await prisma.telegramAuthChallenge.update({ where: { id: challenge.id }, data: { sessionEncrypted: encryptText(result.session), status: 'awaiting_password' } })
      return res.json({ status: 'password_required', challengeId: challenge.id, expiresAt: challenge.expiresAt })
    }
    const providerAccountId = String(result.user.id)
    const displayName = [result.user.firstName, result.user.lastName].filter(Boolean).join(' ') || result.user.username || 'Telegram account'
    const account = await prisma.connectedAccount.upsert({
      where: { userId_provider_providerAccountId: { userId: req.user!.id, provider: 'telegram_mtproto', providerAccountId } },
      create: { userId: req.user!.id, provider: 'telegram_mtproto', providerAccountId, email: `telegram-${providerAccountId}@telegram.oneconnect`, displayName, telegramSessionEncrypted: encryptText(result.session), scopes: ['mtproto_saved_messages'], status: 'connected' },
      update: { email: `telegram-${providerAccountId}@telegram.oneconnect`, displayName, telegramSessionEncrypted: encryptText(result.session), status: 'connected', lastError: null },
    })
    await prisma.telegramAuthChallenge.delete({ where: { id: challenge.id } })
    await createAuditLog(req.user!.id, 'CONNECT_ACCOUNT', 'account', account.id, { provider: 'telegram_mtproto' })
    return res.status(201).json({ status: 'connected', account: { id: account.id, provider: account.provider, email: account.email, displayName: account.displayName, status: account.status, createdAt: account.createdAt, storageAccount: null } })
  } catch (error) { return next(error) }
})

connectedAccountRouter.get('/google/connect-url', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const url = await createGoogleConnectUrl(req)
    return res.json({ url })
  } catch (error) {
    return next(error)
  }
})

connectedAccountRouter.get('/onedrive/connect-url', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const query = z.object({ providerConfigId: z.string().uuid(), client: oauthClientSchema }).parse(req.query)
    const config = await prisma.providerConfig.findFirst({ where: { id: query.providerConfigId, userId: req.user!.id, provider: 'onedrive', status: 'active' } })
    if (!config) return res.status(404).json({ code: 'ONEDRIVE_CONFIG_NOT_FOUND', message: 'OneDrive configuration not found.' })
    const state = randomToken()
    await prisma.oauthState.create({ data: { userId: req.user!.id, providerConfigId: config.id, flow: 'connect', client: query.client, stateHash: hashToken(state), expiresAt: new Date(Date.now() + 10 * 60_000) } })
    return res.json({ url: oneDriveConnectUrl(config, state) })
  } catch (error) { return next(error) }
})

connectedAccountRouter.get('/onedrive/callback', async (req, res) => {
  try {
    const query = z.object({ code: z.string(), state: z.string() }).parse(req.query)
    const stateHash = hashToken(query.state)
    const oauthState = await prisma.oauthState.findUnique({ where: { stateHash }, include: { providerConfig: true } })
    if (!oauthState?.userId || oauthState.flow !== 'connect' || oauthState.usedAt || oauthState.expiresAt < new Date() || oauthState.providerConfig.provider !== 'onedrive') return res.status(400).json({ code: 'ONEDRIVE_OAUTH_STATE_INVALID', message: 'OneDrive OAuth state is invalid or expired.' })
    const claimed = await prisma.oauthState.updateMany({ where: { id: oauthState.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } })
    if (claimed.count !== 1) return res.status(400).json({ code: 'ONEDRIVE_OAUTH_STATE_USED', message: 'OneDrive OAuth state was already used.' })
    const tokens = await exchangeOneDriveCode(oauthState.providerConfig, query.code)
    if (!tokens.access_token || !tokens.refresh_token) throw new Error('OneDrive did not return offline access tokens.')
    const response = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName', { headers: { Authorization: `Bearer ${tokens.access_token}` } })
    if (!response.ok) throw new Error(`OneDrive profile request failed (${response.status}).`)
    const profile = await response.json() as { id?: string; displayName?: string; mail?: string; userPrincipalName?: string }
    if (!profile.id) throw new Error('OneDrive profile did not include an id.')
    const account = await prisma.connectedAccount.upsert({
      where: { userId_provider_providerAccountId: { userId: oauthState.userId, provider: 'onedrive', providerAccountId: profile.id } },
      create: { userId: oauthState.userId, provider: 'onedrive', providerAccountId: profile.id, providerConfigId: oauthState.providerConfigId, email: profile.mail || profile.userPrincipalName || `${profile.id}@onedrive`, displayName: profile.displayName, accessTokenEncrypted: encryptText(tokens.access_token), refreshTokenEncrypted: encryptText(tokens.refresh_token), tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000), scopes: oauthState.providerConfig.scopes as string[], status: 'connected' },
      update: { providerConfigId: oauthState.providerConfigId, email: profile.mail || profile.userPrincipalName || `${profile.id}@onedrive`, displayName: profile.displayName, accessTokenEncrypted: encryptText(tokens.access_token), refreshTokenEncrypted: encryptText(tokens.refresh_token), tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000), scopes: oauthState.providerConfig.scopes as string[], status: 'connected' },
    })
    await syncOneDriveQuota(account.id).catch(() => undefined)
    void syncOneDriveFiles(account.id, account.userId).catch((error) => console.error('OneDrive file discovery failed:', error instanceof Error ? error.message : error))
    await createAuditLog(oauthState.userId, 'CONNECT_ACCOUNT', 'account', account.id, { provider: 'onedrive' })
    return res.redirect(oauthReturnUrl(env.FRONTEND_URL, oauthState.client, 'google-connected', { status: 'success', provider: 'onedrive' }))
  } catch (error) {
    console.error('OneDrive OAuth callback failed:', error instanceof Error ? error.message : error)
    return res.redirect(`${env.FRONTEND_URL}/google-connected?status=error&provider=onedrive`)
  }
})

connectedAccountRouter.get('/google/connect', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const url = await createGoogleConnectUrl(req)
    return res.redirect(url)
  } catch (error) {
    return next(error)
  }
})

connectedAccountRouter.get('/google/callback', async (req, res) => {
  try {
    const query = z.object({ code: z.string(), state: z.string() }).parse(req.query)
    const oauthState = await prisma.oauthState.findUniqueOrThrow({ where: { stateHash: hashToken(query.state) }, include: { providerConfig: true } })
    if (oauthState.usedAt || oauthState.expiresAt < new Date()) return res.status(400).json({ code: 'GOOGLE_OAUTH_STATE_INVALID', message: 'OAuth state expired.' })
    const client = createOAuthClient(oauthState.providerConfig)
    const tokenResult = await client.getToken(query.code)
    const tokens = tokenResult.tokens
    if (!tokens.access_token) return res.status(400).json({ code: 'GOOGLE_OAUTH_FAILED', message: 'Google did not return required tokens.' })
    client.setCredentials(tokens)
    const oauth2 = google.oauth2({ version: 'v2', auth: client })
    const profile = await oauth2.userinfo.get()
    const providerAccountId = profile.data.id
    const email = profile.data.email
    if (!providerAccountId || !email) return res.status(400).json({ code: 'GOOGLE_PROFILE_FAILED', message: 'Google profile missing id or email.' })

    if (oauthState.flow === 'login') {
      const handoffToken = await completeGoogleLogin(oauthState, tokens, profile.data)
      if (!handoffToken) return res.redirect(oauthReturnUrl(env.FRONTEND_URL, oauthState.client, 'google-auth', { status: 'error' }))
      return res.redirect(oauthReturnUrl(env.FRONTEND_URL, oauthState.client, 'google-auth', { token: handoffToken }))
    }

    if (oauthState.flow !== 'connect' || !oauthState.userId) return res.status(400).json({ code: 'GOOGLE_OAUTH_STATE_INVALID', message: 'OAuth state expired.' })
    const existingAccount = await prisma.connectedAccount.findUnique({ where: { userId_provider_providerAccountId: { userId: oauthState.userId, provider: 'google_drive', providerAccountId } } })
    const refreshTokenEncrypted = tokens.refresh_token ? encryptText(tokens.refresh_token) : existingAccount?.refreshTokenEncrypted
    if (!refreshTokenEncrypted) return res.status(400).json({ code: 'GOOGLE_OAUTH_FAILED', message: 'Google did not return required tokens.' })

    const account = await prisma.connectedAccount.upsert({
      where: { userId_provider_providerAccountId: { userId: oauthState.userId, provider: 'google_drive', providerAccountId } },
      create: {
        userId: oauthState.userId,
        providerConfigId: oauthState.providerConfigId,
        provider: 'google_drive',
        providerAccountId,
        email,
        displayName: profile.data.name,
        avatarUrl: profile.data.picture,
        accessTokenEncrypted: encryptText(tokens.access_token),
        refreshTokenEncrypted,
        tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
        scopes: oauthState.providerConfig.scopes as string[],
        status: 'connected',
      },
      update: {
        providerConfigId: oauthState.providerConfigId,
        email,
        displayName: profile.data.name,
        avatarUrl: profile.data.picture,
        accessTokenEncrypted: encryptText(tokens.access_token),
        refreshTokenEncrypted,
        tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
        scopes: oauthState.providerConfig.scopes as string[],
        status: 'connected',
      },
    })
    await prisma.oauthState.update({ where: { id: oauthState.id }, data: { usedAt: new Date() } })
    syncGoogleDriveInBackground(account.id, account.userId)
    await createAuditLog(oauthState.userId, 'CONNECT_ACCOUNT', 'account', account.id, { provider: 'google_drive', accountLabel: accountLabel(account) })
    await syncGoogleQuota(account.id)
    return res.redirect(oauthReturnUrl(env.FRONTEND_URL, oauthState.client, 'google-connected', { status: 'success' }))
  } catch (error) {
    console.error('Google OAuth callback failed:', error)
    return res.redirect(`${env.FRONTEND_URL}/google-connected?status=error`)
  }
})

connectedAccountRouter.post('/:id/sync-quota', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const accountId = String(req.params.id)
    const account = await prisma.connectedAccount.findFirstOrThrow({ where: { id: accountId, userId: req.user!.id } })
    const quota = await syncQuotaForAccount(account)
    return res.json({
      quota: {
        ...quota,
        totalBytes: quota.totalBytes?.toString() ?? null,
        usedBytes: quota.usedBytes.toString(),
        availableBytes: quota.availableBytes?.toString() ?? null,
        trashBytes: quota.trashBytes?.toString() ?? null,
      },
    })
  } catch (error) {
    return next(error)
  }
})

connectedAccountRouter.delete('/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const accountId = String(req.params.id)
    const account = await prisma.connectedAccount.findFirst({ where: { id: accountId, userId: req.user!.id } })
    const result = await prisma.connectedAccount.updateMany({ where: { id: accountId, userId: req.user!.id }, data: { status: 'disconnected', ...(account?.provider === 'telegram_bot' || account?.provider === 'telegram_mtproto' ? { accessTokenEncrypted: null, refreshTokenEncrypted: null, telegramSessionEncrypted: null } : {}) } })
    if (result.count > 0 && account) await createAuditLog(req.user!.id, 'DISCONNECT_ACCOUNT', 'account', account.id, { provider: account.provider, accountLabel: accountLabel(account) })
    // The account's My Drive import goes with it; otherwise its locked 'Drive · email' folder and
    // everything under it would stay in the app with no way to remove them.
    if (account?.provider === 'google_drive') await removeImportedDrive(req.user!.id, account.id)
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})
