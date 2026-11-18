import type { ConnectedAccount, Folder } from '../../generated/prisma/client.js'
import { prisma } from '../../config/prisma.js'
import { decryptText, encryptText } from '../../utils/crypto.js'
import { defaultFolderColor, defaultFolderIconUrl } from '../folders/folder-defaults.js'
import { OneDriveGraphError, oneDriveDeltaPage, oneDriveGraph } from './onedrive.service.js'

type DriveItem = {
  id: string
  name?: string
  size?: number
  eTag?: string
  folder?: Record<string, unknown>
  file?: { mimeType?: string }
  deleted?: Record<string, unknown>
  parentReference?: { id?: string }
}
type DeltaPage = { value: DriveItem[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string }
const MAX_DISCOVERY_ITEMS = 25_000
const running = new Map<string, Promise<{ mode: 'full' | 'incremental'; changed: number }>>()

async function collectDelta(account: ConnectedAccount, start: string) {
  const changed = new Map<string, DriveItem>()
  let url: string | undefined = start
  let cursor: string | undefined
  while (url) {
    const page: DeltaPage = await oneDriveDeltaPage<DeltaPage>(account, url)
    if (!Array.isArray(page.value)) throw new Error('OneDrive returned an invalid delta page.')
    for (const item of page.value) {
      if (!item.id || item.id.length > 191) throw new Error('OneDrive returned an invalid item id.')
      changed.set(item.id, item) // Graph may repeat an item; its last occurrence wins.
      if (changed.size > MAX_DISCOVERY_ITEMS) throw new Error('OneDrive discovery exceeds the 25,000-item safety limit.')
    }
    url = page['@odata.nextLink']
    cursor = page['@odata.deltaLink'] ?? cursor
    if (!url && !cursor) throw new Error('OneDrive did not return a completed delta cursor.')
  }
  return { changed, cursor: cursor! }
}

async function runSync(account: ConnectedAccount, forceFull: boolean) {
  const startedAt = new Date()
  let mode: 'full' | 'incremental' = forceFull || !account.oneDriveDeltaLinkEncrypted ? 'full' : 'incremental'
  let snapshot: Awaited<ReturnType<typeof collectDelta>>
  try {
    snapshot = await collectDelta(account, mode === 'full' ? '/me/drive/root/delta' : decryptText(account.oneDriveDeltaLinkEncrypted!))
  } catch (error) {
    if (mode !== 'incremental' || !(error instanceof OneDriveGraphError) || error.status !== 410) throw error
    mode = 'full'
    snapshot = await collectDelta(account, '/me/drive/root/delta')
  }
  if (!(await prisma.connectedAccount.count({ where: { id: account.id, status: 'connected' } }))) throw new Error('OneDrive account was disconnected during discovery.')

  const root = await oneDriveGraph<{ id: string }>(account, '/me/drive/root?$select=id')
  if (!root.id) throw new Error('OneDrive did not return a root folder id.')
  let accountRoot = await prisma.folder.findFirst({ where: { connectedAccountId: account.id, provider: 'onedrive', source: 'drive_root' } })
  if (!accountRoot) accountRoot = await prisma.folder.create({ data: { userId: account.userId, connectedAccountId: account.id, provider: 'onedrive', providerFolderId: root.id, source: 'drive_root', name: `OneDrive · ${account.displayName || account.email}`.slice(0, 255), color: defaultFolderColor, iconUrl: defaultFolderIconUrl } })
  const existingFolders = await prisma.folder.findMany({ where: { connectedAccountId: account.id, provider: 'onedrive' }, take: MAX_DISCOVERY_ITEMS + 1 })
  const existingFiles = await prisma.file.findMany({ where: { connectedAccountId: account.id, provider: 'onedrive' }, take: MAX_DISCOVERY_ITEMS + 1 })
  if (existingFolders.length > MAX_DISCOVERY_ITEMS || existingFiles.length > MAX_DISCOVERY_ITEMS) throw new Error('OneDrive account exceeds the discovery safety limit.')
  const folders = new Map(existingFolders.filter((folder) => folder.providerFolderId).map((folder) => [folder.providerFolderId!, folder]))
  const files = new Map(existingFiles.map((file) => [file.providerFileId, file]))
  folders.set(root.id, accountRoot)
  let changedCount = 0

  async function ensureFolder(id: string | undefined, visiting = new Set<string>()): Promise<Folder> {
    if (!id || id === root.id) return accountRoot!
    const known = folders.get(id)
    const changed = snapshot.changed.get(id)
    if (known && (!changed || changed.deleted)) return known
    if (visiting.has(id) || visiting.size > 32) throw new Error('OneDrive returned a cyclic or overly deep folder tree.')
    visiting.add(id)
    const item = changed?.folder && changed.name && changed.parentReference?.id ? changed : await oneDriveGraph<DriveItem>(account, `/me/drive/items/${encodeURIComponent(id)}?$select=id,name,folder,parentReference`)
    if (!item.folder || !item.name || item.name.length > 255) throw new Error('OneDrive parent folder metadata is invalid.')
    const parent = await ensureFolder(item.parentReference?.id, visiting)
    visiting.delete(id)
    if (known) {
      if (known.updatedAt < startedAt && (known.name !== item.name || known.parentId !== parent.id || known.deletedAt)) {
        const updated = await prisma.folder.update({ where: { id: known.id }, data: { name: item.name, parentId: parent.id, deletedAt: null, deletedBySync: false } })
        folders.set(id, updated)
        changedCount++
        return updated
      }
      return known
    }
    const created = await prisma.folder.create({ data: { userId: account.userId, connectedAccountId: account.id, provider: 'onedrive', providerFolderId: id, source: 'drive', name: item.name, parentId: parent.id, color: defaultFolderColor, iconUrl: defaultFolderIconUrl } })
    folders.set(id, created)
    changedCount++
    return created
  }

  for (const item of snapshot.changed.values()) if (item.folder && !item.deleted && item.id !== root.id) await ensureFolder(item.id)
  for (const changed of snapshot.changed.values()) {
    if (changed.deleted || !changed.file) continue
    const item = changed.name && Number.isSafeInteger(changed.size) && changed.parentReference?.id
      ? changed
      : await oneDriveGraph<DriveItem>(account, `/me/drive/items/${encodeURIComponent(changed.id)}?$select=id,name,size,eTag,file,parentReference`)
    if (!item.name || item.name.length > 255 || !Number.isSafeInteger(item.size) || item.size! < 0) throw new Error('OneDrive returned invalid file metadata.')
    const parent = await ensureFolder(item.parentReference?.id)
    const previous = files.get(item.id)
    const appFolder = previous?.folderId && [...folders.values()].find((folder) => folder.id === previous.folderId && folder.source === 'app')
    const folderId = appFolder ? previous!.folderId : parent.id
    const mimeType = (item.file?.mimeType || changed.file.mimeType || 'application/octet-stream').slice(0, 191)
    const version = item.eTag?.slice(0, 191) ?? null
    if (!previous) {
      const created = await prisma.file.create({ data: { userId: account.userId, connectedAccountId: account.id, provider: 'onedrive', providerFileId: item.id, name: item.name, mimeType, sizeBytes: BigInt(item.size!), providerVersion: version, folderId } })
      files.set(item.id, created)
      changedCount++
    } else if (previous.updatedAt < startedAt && (previous.status === 'active' || previous.deletedBySync)) {
      if (previous.name !== item.name || previous.mimeType !== mimeType || previous.sizeBytes !== BigInt(item.size!) || previous.providerVersion !== version || previous.folderId !== folderId || previous.status !== 'active') {
        const updated = await prisma.file.update({ where: { id: previous.id }, data: { name: item.name, mimeType, sizeBytes: BigInt(item.size!), providerVersion: version, folderId, status: 'active', deletedAt: null, deletedBySync: false } })
        files.set(item.id, updated)
        changedCount++
      }
    }
  }

  const removedIds = new Set([...snapshot.changed.values()].filter((item) => item.deleted).map((item) => item.id))
  if (mode === 'full') {
    for (const file of existingFiles) if (!snapshot.changed.has(file.providerFileId)) removedIds.add(file.providerFileId)
    for (const folder of existingFolders) if (folder.source === 'drive' && folder.providerFolderId && !snapshot.changed.has(folder.providerFolderId)) removedIds.add(folder.providerFolderId)
  }
  for (const id of removedIds) {
    const file = files.get(id)
    if (file?.status === 'active') changedCount += (await prisma.file.updateMany({ where: { id: file.id, updatedAt: { lt: startedAt } }, data: { status: 'deleted', deletedAt: new Date(), deletedBySync: true } })).count
  }
  // Graph can return a parent before its children. Remove empty leaves first and then ancestors.
  for (let depth = 0; depth < 32; depth++) {
    let removedAtThisDepth = 0
    for (const id of removedIds) {
      const folder = folders.get(id)
      if (!folder || folder.source !== 'drive' || folder.deletedAt) continue
      const [activeFiles, activeChildren] = await Promise.all([
        prisma.file.count({ where: { folderId: folder.id, status: 'active' } }),
        prisma.folder.count({ where: { parentId: folder.id, deletedAt: null } }),
      ])
      if (activeFiles || activeChildren) continue
      const result = await prisma.folder.updateMany({ where: { id: folder.id, updatedAt: { lt: startedAt } }, data: { deletedAt: new Date(), deletedBySync: true } })
      if (result.count) {
        folder.deletedAt = new Date()
        removedAtThisDepth += result.count
      }
    }
    changedCount += removedAtThisDepth
    if (!removedAtThisDepth) break
  }
  await prisma.connectedAccount.update({ where: { id: account.id }, data: { oneDriveDeltaLinkEncrypted: encryptText(snapshot.cursor), lastError: null } })
  return { mode, changed: changedCount }
}

export function syncOneDriveFiles(accountId: string, userId: string, forceFull = false) {
  const pending = running.get(accountId)
  if (pending) return pending
  const task = (async () => {
    const account = await prisma.connectedAccount.findFirstOrThrow({ where: { id: accountId, userId, provider: 'onedrive', status: 'connected' } })
    return runSync(account, forceFull)
  })().finally(() => running.delete(accountId))
  running.set(accountId, task)
  return task
}
