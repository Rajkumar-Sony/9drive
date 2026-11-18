import { Readable } from 'node:stream'
import type { ConnectedAccount, ProviderConfig } from '../../generated/prisma/client.js'
import { prisma } from '../../config/prisma.js'
import { decryptText, encryptText } from '../../utils/crypto.js'

const authority = 'https://login.microsoftonline.com/common/oauth2/v2.0'
const graph = 'https://graph.microsoft.com/v1.0'

export class OneDriveGraphError extends Error {
  constructor(readonly status: number) {
    super(`OneDrive request failed (${status}).`)
  }
}

export function oneDriveDeltaUrl(input: string): string {
  const url = new URL(input.startsWith('/') ? `${graph}${input}` : input)
  if (url.protocol !== 'https:' || url.origin !== 'https://graph.microsoft.com' || !url.pathname.startsWith('/v1.0/me/drive/')) {
    throw new Error('OneDrive returned an unexpected delta URL.')
  }
  return url.toString()
}

export async function oneDriveDeltaPage<T>(account: ConnectedAccount, input: string): Promise<T> {
  const url = oneDriveDeltaUrl(input)
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${await oneDriveAccessToken(account)}` } })
    if (response.ok) return response.json() as Promise<T>
    if (attempt < 3 && [429, 500, 502, 503, 504].includes(response.status)) {
      const seconds = Number(response.headers.get('retry-after'))
      const delay = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 30_000) : 1000 * 2 ** attempt
      await new Promise((resolve) => setTimeout(resolve, delay))
      continue
    }
    throw new OneDriveGraphError(response.status)
  }
  throw new Error('OneDrive delta request failed after retries.')
}

export function oneDriveConnectUrl(config: ProviderConfig, state: string) {
  const url = new URL(`${authority}/authorize`)
  url.search = new URLSearchParams({ client_id: decryptText(config.clientIdEncrypted), response_type: 'code', redirect_uri: config.redirectUri, response_mode: 'query', scope: (config.scopes as string[]).join(' '), state }).toString()
  return url.toString()
}

export async function exchangeOneDriveCode(config: ProviderConfig, code: string) {
  const response = await fetch(`${authority}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: decryptText(config.clientIdEncrypted), client_secret: decryptText(config.clientSecretEncrypted), code, redirect_uri: config.redirectUri, grant_type: 'authorization_code' }) })
  if (!response.ok) throw new Error(`OneDrive token exchange failed (${response.status}).`)
  return response.json() as Promise<{ access_token: string; refresh_token?: string; expires_in: number }>
}

export async function oneDriveAccessToken(account: ConnectedAccount) {
  if (!account.accessTokenEncrypted || !account.refreshTokenEncrypted || !account.providerConfigId) throw new Error('OneDrive account tokens are missing.')
  if (account.tokenExpiresAt && account.tokenExpiresAt.getTime() > Date.now() + 60_000) return decryptText(account.accessTokenEncrypted)
  const config = await prisma.providerConfig.findUniqueOrThrow({ where: { id: account.providerConfigId } })
  const response = await fetch(`${authority}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: decryptText(config.clientIdEncrypted), client_secret: decryptText(config.clientSecretEncrypted), refresh_token: decryptText(account.refreshTokenEncrypted), grant_type: 'refresh_token', scope: (config.scopes as string[]).join(' ') }) })
  if (!response.ok) throw new Error(`OneDrive token refresh failed (${response.status}).`)
  const token = await response.json() as { access_token: string; refresh_token?: string; expires_in: number }
  const encryptedAccessToken = encryptText(token.access_token)
  const encryptedRefreshToken = token.refresh_token ? encryptText(token.refresh_token) : account.refreshTokenEncrypted
  const tokenExpiresAt = new Date(Date.now() + token.expires_in * 1000)
  await prisma.connectedAccount.update({ where: { id: account.id }, data: { accessTokenEncrypted: encryptedAccessToken, refreshTokenEncrypted: encryptedRefreshToken, tokenExpiresAt } })
  account.accessTokenEncrypted = encryptedAccessToken
  account.refreshTokenEncrypted = encryptedRefreshToken
  account.tokenExpiresAt = tokenExpiresAt
  return token.access_token
}

export async function oneDriveGraph<T>(account: ConnectedAccount, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${graph}${path}`, { ...init, headers: { Authorization: `Bearer ${await oneDriveAccessToken(account)}`, ...init.headers } })
  if (!response.ok) throw new Error(`OneDrive request failed (${response.status}).`)
  return response.json() as Promise<T>
}

export async function syncOneDriveQuota(accountId: string) {
  const account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } })
  const drive = await oneDriveGraph<{ quota?: { total?: number; used?: number; remaining?: number } }>(account, '/me/drive?$select=quota')
  const total = drive.quota?.total === undefined ? null : BigInt(drive.quota.total)
  const used = BigInt(drive.quota?.used ?? 0)
  return prisma.storageAccount.upsert({ where: { connectedAccountId: account.id }, create: { connectedAccountId: account.id, totalBytes: total, usedBytes: used, availableBytes: drive.quota?.remaining === undefined ? null : BigInt(drive.quota.remaining), lastSyncedAt: new Date() }, update: { totalBytes: total, usedBytes: used, availableBytes: drive.quota?.remaining === undefined ? null : BigInt(drive.quota.remaining), lastSyncedAt: new Date() } })
}

export async function oneDriveDownload(account: ConnectedAccount, itemId: string) {
  const item = await oneDriveGraph<{ '@microsoft.graph.downloadUrl'?: string }>(account, `/me/drive/items/${encodeURIComponent(itemId)}?$select=id,@microsoft.graph.downloadUrl`)
  const url = item['@microsoft.graph.downloadUrl']
  if (!url) throw new Error('OneDrive did not provide a download URL.')
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`OneDrive download failed (${response.status}).`)
  return Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
}
