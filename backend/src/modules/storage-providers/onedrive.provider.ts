import { Readable } from 'node:stream'
import type { StorageProvider } from './provider.js'
import { STORAGE_PROVIDER_CAPABILITIES } from './capabilities.js'
import { oneDriveAccessToken, oneDriveDownload, oneDriveGraph, syncOneDriveQuota } from '../onedrive/onedrive.service.js'
import { pipeToResponse, setFileResponseHeaders } from '../files/file-response.js'

const GRAPH = 'https://graph.microsoft.com/v1.0'
const PART_BYTES = 10 * 1024 * 1024 // 32 × 320 KiB, the Graph upload fragment unit.

async function* chunks(body: Readable) {
  let pending = Buffer.alloc(0)
  for await (const value of body) {
    pending = Buffer.concat([pending, value as Buffer])
    while (pending.length >= PART_BYTES) {
      yield pending.subarray(0, PART_BYTES)
      pending = pending.subarray(PART_BYTES)
    }
  }
  if (pending.length) yield pending
}

export const oneDriveProvider: StorageProvider = {
  type: 'onedrive',
  capabilities: STORAGE_PROVIDER_CAPABILITIES.onedrive,
  syncQuota: syncOneDriveQuota,
  async streamFile(file, _range, res, options) {
    const source = await oneDriveDownload(file.connectedAccount, file.providerFileId)
    setFileResponseHeaders(res, { mimeType: file.mimeType, fileName: file.name, disposition: options?.disposition })
    res.setHeader('Content-Length', file.sizeBytes.toString())
    return pipeToResponse(source, res)
  },
  async deleteFile(file) {
    const response = await fetch(`${GRAPH}/me/drive/items/${encodeURIComponent(file.providerFileId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${await oneDriveAccessToken(file.connectedAccount)}` } })
    if (!response.ok && response.status !== 404) throw new Error(`OneDrive delete failed (${response.status}).`)
  },
  async openDownload(file) { return oneDriveDownload(file.connectedAccount, file.providerFileId) },
  async uploadStream({ account, name, sizeBytes, body }) {
    const safeName = encodeURIComponent(name)
    const session = await oneDriveGraph<{ uploadUrl: string }>(account, `/me/drive/root:/${safeName}:/createUploadSession`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename' } }) })
    if (!session.uploadUrl || new URL(session.uploadUrl).protocol !== 'https:') throw new Error('OneDrive returned an invalid upload session URL.')
    let offset = 0n
    let completed: { id?: string; size?: number } | null = null
    for await (const chunk of chunks(body)) {
      const end = offset + BigInt(chunk.length) - 1n
      let response: Response | null = null
      for (let attempt = 0; attempt < 5; attempt++) {
        response = await fetch(session.uploadUrl, { method: 'PUT', headers: { 'Content-Length': String(chunk.length), 'Content-Range': `bytes ${offset}-${end}/${sizeBytes}` }, body: new Uint8Array(chunk) })
        if (response.ok) break
        if (response.status !== 429 && response.status < 500) break
        const wait = Number(response.headers.get('retry-after')) || Math.min(30, 2 ** attempt)
        await new Promise((resolve) => setTimeout(resolve, wait * 1000))
      }
      if (!response?.ok) throw new Error(`OneDrive upload chunk failed (${response?.status ?? 'network'}).`)
      if (response.status === 200 || response.status === 201) completed = await response.json() as { id?: string; size?: number }
      offset = end + 1n
    }
    if (offset !== sizeBytes || !completed?.id || BigInt(completed.size ?? -1) !== sizeBytes) throw new Error('OneDrive destination size did not match the source size.')
    return { providerFileId: completed.id, confirmedSizeBytes: sizeBytes }
  },
}
