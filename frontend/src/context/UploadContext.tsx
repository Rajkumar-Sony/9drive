import { createContext, useContext, useState, type ReactNode } from 'react'
import { isDesktop } from '@/lib/runtime'
import { DesktopUploadProvider } from '@/context/DesktopUploadProvider'
import type { PickedFile } from '@/lib/desktop'
import { resolveUploadFolder as resolveFolderPath } from '@/lib/upload-folders'
import { ApiError, getApiUrl, apiFetch, authedFetch, refreshAccessToken } from '@/lib/api'
import { clearAuthSession, getAccessToken } from '@/lib/auth'

export type UploadProgressStatus = 'queued' | 'uploading' | 'paused' | 'done' | 'error' | 'partial'
// `detail` is a short note shown under an active upload (e.g. waiting for the connection).
export type UploadProgressFile = { id: string; name: string; size: number; percent: number; status: UploadProgressStatus; accountLabel?: string; error?: string; detail?: string; uploaded?: number; speed?: number }
export type UploadProgressState = { open: boolean; fileName: string; percent: number; status: UploadProgressStatus; files: UploadProgressFile[] }

type ResumableSession = { sessionId: string; file: File; folderId?: string | null; targetAccountId?: string | null }

export type UploadContextType = {
  uploadProgress: UploadProgressState
  setUploadProgress: React.Dispatch<React.SetStateAction<UploadProgressState>>
  // Web: browser File objects. Desktop: local paths, uploaded by the native uploader.
  uploadFiles: (files: File[], folderId: string | null, targetAccountId?: string | null) => Promise<void>
  uploadPaths: (paths: string[], folderId: string | null, targetAccountId?: string | null) => Promise<void>
  uploadNativeFiles?: (files: PickedFile[], folderId: string | null, targetAccountId?: string | null) => Promise<void>
  retryFailedUpload: (uploadId: string) => Promise<void>
  // Desktop only.
  pauseUpload?: (uploadId: string) => Promise<void>
  resumeUpload?: (uploadId: string) => Promise<void>
  cancelUpload?: (uploadId: string) => Promise<void>
}

export const UploadContext = createContext<UploadContextType | undefined>(undefined)

// Per-upload ids keep same-named files from sharing progress rows or resumable sessions.
let uploadCounter = 0
const newUploadId = () => `upload-${Date.now()}-${++uploadCounter}`

// 16 MiB: a multiple of 256 KiB (Google Drive requirement), far fewer requests than 5 MiB for
// multi-GB files, and well under Cloudflare's 100 MB per-request body limit.
const CHUNK_SIZE = 16 * 1024 * 1024
// A multi-hour upload will hit network blips and Google 5xx/429s; retry a chunk this many times
// (resuming from the offset Google actually stored) before giving up.
const MAX_CHUNK_ATTEMPTS = 6
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))
const errorMessage = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback)

export function UploadProvider({ children }: { children: ReactNode }) {
  return isDesktop ? <DesktopUploadProvider>{children}</DesktopUploadProvider> : <WebUploadProvider>{children}</WebUploadProvider>
}

function WebUploadProvider({ children }: { children: ReactNode }) {
  const [uploadProgress, setUploadProgress] = useState<UploadProgressState>({
    open: false,
    fileName: '',
    percent: 0,
    status: 'uploading',
    files: []
  })
  const [resumableSessions, setResumableSessions] = useState<Record<string, ResumableSession>>({})

  async function resolveUploadFolder(file: File, rootFolderId: string | null, cache: Map<string, string>) {
    return resolveFolderPath(file.webkitRelativePath, rootFolderId, cache)
  }

  function uploadSingleFileMultipart(file: File, folderId: string | null, accountId: string | null, onProgress: (percent: number) => void) {
    const attempt = () => new Promise<void>((resolve, reject) => {
      const form = new FormData()
      // Text fields go before the file so the server can read them while streaming.
      form.append('sizeBytes', String(file.size))
      form.append('fileName', file.name)
      form.append('mimeType', file.type || 'application/octet-stream')
      if (folderId) form.append('folderId', folderId)
      if (accountId) form.append('targetAccountId', accountId)
      form.append('file', file, file.name)

      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${getApiUrl()}/uploads`)
      xhr.setRequestHeader('Authorization', `Bearer ${getAccessToken()}`)
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)))
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress(100)
          resolve()
          return
        }
        let message = `Upload failed (${xhr.status})`
        try {
          const body = JSON.parse(xhr.responseText) as { message?: string; failed?: { message?: string }[] }
          message = body.failed?.[0]?.message || body.message || message
        } catch {
          // non-JSON error body; keep the status text
        }
        const error = new Error(message) as Error & { status?: number }
        error.status = xhr.status
        reject(error)
      }
      xhr.onerror = () => reject(new Error('Upload failed'))
      xhr.onabort = () => reject(new Error('Upload cancelled'))
      xhr.send(form)
    })

    return attempt().catch(async (error: Error & { status?: number }) => {
      // Expired access token: refresh once and retry the whole request.
      if (error.status === 401) {
        if (await refreshAccessToken()) {
          onProgress(0)
          return attempt().catch((retryError: Error & { status?: number }) => {
            if (retryError.status === 401) clearAuthSession()
            throw retryError
          })
        }
        clearAuthSession()
      }
      throw error
    })
  }

  async function uploadSingleFileResumable(uploadId: string, file: File, folderId: string | null, onProgress: (percent: number) => void, sessionIdToRetry?: string, targetAccountId?: string | null, onAccountLabel?: (label: string) => void) {
    let sessionId = sessionIdToRetry || ''
    let startOffset = 0
    let chunkSize = CHUNK_SIZE

    // Pre-save session parameters so that retry is functional even if the init API call fails
    setResumableSessions(prev => ({
      ...prev,
      [uploadId]: { sessionId, file, folderId, targetAccountId }
    }))

    // 1. Initialize or get status
    if (!sessionId) {
      const initData = await apiFetch<{ sessionId?: string; provider: string; accountId?: string; accountLabel?: string; partSize?: number; partCount?: number; chunkSize?: number }>('/uploads/resumable/init', {
        method: 'POST',
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: String(file.size),
          folderId: folderId || undefined,
          targetAccountId: targetAccountId || undefined,
          chunkedProxy: true
        })
      })
      if (initData.accountLabel) onAccountLabel?.(initData.accountLabel)
      if (initData.provider === 's3') {
        if (!initData.sessionId || !initData.partSize || !initData.partCount) {
          await uploadSingleFileMultipart(file, folderId, initData.accountId ?? targetAccountId ?? null, onProgress)
          return
        }
        sessionId = initData.sessionId
        setResumableSessions(prev => ({ ...prev, [uploadId]: { sessionId, file, folderId, targetAccountId } }))
        await uploadBrowserS3Parts(uploadId, sessionId, file, folderId, targetAccountId, initData.partSize, initData.partCount, onProgress)
        return
      }
      if (!initData.sessionId) throw new Error('Upload session was not created')
      sessionId = initData.sessionId
      chunkSize = initData.chunkSize ?? CHUNK_SIZE
      // Update session with the active sessionId
      setResumableSessions(prev => ({
        ...prev,
        [uploadId]: { sessionId, file, folderId, targetAccountId }
      }))
    } else {
      const s3Status = await apiFetch<{ status: string; partSize: number; partCount: number }>(`/uploads/s3/${sessionId}/parts`).catch((error) => {
        if (error instanceof ApiError && error.code === 'S3_UPLOAD_EXPIRED') return { status: 'expired', partSize: 0, partCount: 0 }
        return null
      })
      if (s3Status?.status === 'expired') {
        await restartExpiredS3Upload(uploadId, file, folderId, targetAccountId, onProgress)
        return
      }
      if (s3Status) {
        await uploadBrowserS3Parts(uploadId, sessionId, file, folderId, targetAccountId, s3Status.partSize, s3Status.partCount, onProgress)
        return
      }
      const statusData = await apiFetch<{ status: string; offset: string; chunkSize?: number }>(`/uploads/resumable/status/${sessionId}`)
      startOffset = Number(statusData.offset)
      chunkSize = statusData.chunkSize ?? CHUNK_SIZE
      if (statusData.status === 'completed') {
        onProgress(100)
        return
      }
    }

    // 2. Upload chunk by chunk
    let failedAttempts = 0
    while (startOffset < file.size) {
      const endOffset = Math.min(startOffset + chunkSize, file.size)
      const chunk = file.slice(startOffset, endOffset)

      let response: Response | null = null
      try {
        // Raw fetch for the binary body; authedFetch refreshes an expired token mid-upload.
        response = await authedFetch(`/uploads/resumable/chunk/${sessionId}`, {
          method: 'PUT',
          headers: {
            'Content-Range': `bytes ${startOffset}-${endOffset - 1}/${file.size}`,
          },
          body: chunk
        })
      } catch {
        response = null // network error: retry below
      }

      const retriable = !response || response.status >= 500 || response.status === 429
      if (retriable) {
        failedAttempts += 1
        if (failedAttempts >= MAX_CHUNK_ATTEMPTS) {
          const body = response ? await response.json().catch(() => null) as { message?: string } | null : null
          throw new Error(body?.message || 'Upload kept failing; check your connection and press Retry.')
        }
        await sleep(Math.min(30_000, 1000 * 2 ** failedAttempts))
        // Resume from what Google actually stored; a failed chunk may be partly persisted.
        try {
          const status = await apiFetch<{ status: string; offset: string }>(`/uploads/resumable/status/${sessionId}`)
          if (status.status === 'completed') {
            onProgress(100)
            return
          }
          if (status.status === 'uploading') startOffset = Number(status.offset)
        } catch {
          // keep the current offset; the next chunk response will correct it
        }
        continue
      }

      if (!response!.ok) {
        const body = await response!.json().catch(() => null) as { message?: string } | null
        throw new Error(body?.message || 'Chunk upload failed')
      }
      failedAttempts = 0

      const resData = await response!.json() as { status: string; offset?: string }
      if (resData.status === 'completed') {
        onProgress(100)
        break
      }

      startOffset = Number(resData.offset)
      const percent = Math.min(99, Math.round((startOffset / file.size) * 100))
      onProgress(percent)
    }
  }

  async function restartExpiredS3Upload(uploadId: string, file: File, folderId: string | null, targetAccountId: string | null | undefined, onProgress: (percent: number) => void) {
    const initData = await apiFetch<{ sessionId?: string; provider: string; accountId?: string; accountLabel?: string; partSize?: number; partCount?: number }>('/uploads/resumable/init', {
      method: 'POST',
      body: JSON.stringify({ fileName: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: String(file.size), folderId: folderId || undefined, targetAccountId: targetAccountId || undefined, chunkedProxy: true }),
    })
    if (initData.provider !== 's3' || !initData.sessionId || !initData.partSize || !initData.partCount) throw new Error('S3 created a replacement session that this browser cannot resume.')
    const sessionId = initData.sessionId
    setResumableSessions((current) => ({ ...current, [uploadId]: { sessionId, file, folderId, targetAccountId } }))
    if (initData.accountLabel) updateFileProgress(uploadId, { accountLabel: initData.accountLabel })
    await uploadBrowserS3Parts(uploadId, sessionId, file, folderId, targetAccountId, initData.partSize, initData.partCount, onProgress)
  }

  async function uploadBrowserS3Parts(uploadId: string, sessionId: string, file: File, folderId: string | null, targetAccountId: string | null | undefined, partSize: number, partCount: number, onProgress: (percent: number) => void) {
    let status: { status: string; parts: Array<{ partNumber: number; etag: string; size: number }> }
    try { status = await apiFetch(`/uploads/s3/${sessionId}/parts`) }
    catch (error) {
      if (error instanceof ApiError && error.code === 'S3_UPLOAD_EXPIRED') return restartExpiredS3Upload(uploadId, file, folderId, targetAccountId, onProgress)
      throw error
    }
    for (let check = 0; status.status === 'completing' && check < 15; check++) {
      await sleep(2000)
      try { status = await apiFetch(`/uploads/s3/${sessionId}/parts`) }
      catch (error) {
        if (error instanceof ApiError && error.code === 'S3_UPLOAD_EXPIRED') return restartExpiredS3Upload(uploadId, file, folderId, targetAccountId, onProgress)
        throw error
      }
    }
    if (status.status === 'completed') { onProgress(100); return }
    if (status.status !== 'uploading') throw new Error(`S3 upload is ${status.status}`)
    const parts = new Map(status.parts.map((part) => [part.partNumber, part.etag]))
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      if (parts.has(partNumber)) continue
      const start = (partNumber - 1) * partSize
      const chunk = file.slice(start, Math.min(start + partSize, file.size))
      let lastError: Error | null = null
      for (let attempt = 0; attempt < MAX_CHUNK_ATTEMPTS; attempt++) {
        try {
          const response = await authedFetch(`/uploads/s3/${sessionId}/parts/${partNumber}`, { method: 'PUT', body: chunk })
          if (!response.ok) throw new Error(`S3 part ${partNumber} failed (${response.status})`)
          const result = await response.json() as { etag: string }
          parts.set(partNumber, result.etag)
          lastError = null
          break
        } catch (error) {
          lastError = error instanceof Error ? error : new Error('S3 part upload failed')
          await sleep(Math.min(30_000, 1000 * 2 ** attempt))
        }
      }
      if (lastError) throw lastError
      onProgress(Math.min(99, Math.round((parts.size / partCount) * 100)))
    }
    try {
      await apiFetch(`/uploads/s3/${sessionId}/complete`, { method: 'POST', body: JSON.stringify({ parts: [...parts].sort(([a], [b]) => a - b).map(([partNumber, etag]) => ({ partNumber, etag })) }) })
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'UPLOAD_COMPLETION_IN_PROGRESS') throw error
      for (let check = 0; check < 15; check++) {
        await sleep(2000)
        try {
          const current = await apiFetch<{ status: string }>(`/uploads/s3/${sessionId}/parts`)
          if (current.status === 'completed') { onProgress(100); return }
          if (current.status === 'uploading') throw error
        } catch (retryError) {
          if (retryError instanceof ApiError && retryError.code === 'S3_UPLOAD_EXPIRED') return restartExpiredS3Upload(uploadId, file, folderId, targetAccountId, onProgress)
          if (retryError === error) throw retryError
          throw retryError
        }
      }
      throw new Error('S3 is still finalizing this upload. Retry the upload to reconcile it.')
    }
    onProgress(100)
  }

  function updateFileProgress(uploadId: string, patch: Partial<UploadProgressFile>, overallStatus?: (files: UploadProgressFile[]) => UploadProgressStatus | undefined) {
    setUploadProgress((current) => {
      const files = current.files.map((f) => (f.id === uploadId ? { ...f, ...patch } : f))
      const percent = files.length ? Math.round(files.reduce((sum, f) => sum + f.percent, 0) / files.length) : 0
      return { ...current, files, percent, status: overallStatus?.(files) ?? current.status }
    })
  }

  async function uploadFiles(filesToUpload: File[], targetFolderId: string | null, targetAccountId?: string | null) {
    if (filesToUpload.length === 0) return
    const uploadIds = filesToUpload.map(() => newUploadId())
    const folderCache = new Map<string, string>()

    // Setup initial status
    setUploadProgress({
      open: true,
      fileName: filesToUpload.length === 1 ? filesToUpload[0].name : `${filesToUpload.length} files`,
      percent: 0,
      status: 'uploading',
      files: filesToUpload.map((f, idx) => ({ id: uploadIds[idx], name: f.name, size: f.size, percent: 0, status: idx === 0 ? 'uploading' : 'queued' }))
    })

    // Upload files sequentially
    for (let i = 0; i < filesToUpload.length; i++) {
      const file = filesToUpload[i]
      const uploadId = uploadIds[i]
      setUploadProgress((current) => ({
        ...current,
        files: current.files.map((f) => (f.id === uploadId && f.status === 'queued' ? { ...f, status: 'uploading' } : f)),
      }))
      try {
        const fileFolderId = await resolveUploadFolder(file, targetFolderId, folderCache)
        await uploadSingleFileResumable(uploadId, file, fileFolderId, (filePercent) => {
          updateFileProgress(uploadId, { percent: filePercent, status: filePercent >= 100 ? 'done' : 'uploading' })
        }, undefined, targetAccountId, (label) => updateFileProgress(uploadId, { accountLabel: label }))
      } catch (err) {
        console.error('File upload failed:', file.name, err)
        updateFileProgress(uploadId, { status: 'error', error: errorMessage(err, 'Upload failed') }, () => 'partial')
      }
    }

    // Dispatch global events so active pages reload their data
    window.dispatchEvent(new Event('oneconnect:storage-changed'))
    window.dispatchEvent(new Event('oneconnect:upload-completed'))
  }

  async function retryFailedUpload(uploadId: string) {
    const session = resumableSessions[uploadId]
    if (!session) return

    updateFileProgress(uploadId, { status: 'uploading', error: undefined }, () => 'uploading')

    try {
      await uploadSingleFileResumable(uploadId, session.file, session.folderId || null, (filePercent) => {
        updateFileProgress(uploadId, { percent: filePercent, status: filePercent >= 100 ? 'done' : 'uploading' }, (files) => (files.every((f) => f.status === 'done') ? 'done' : 'uploading'))
      }, session.sessionId, session.targetAccountId)

      window.dispatchEvent(new Event('oneconnect:storage-changed'))
      window.dispatchEvent(new Event('oneconnect:upload-completed'))
    } catch (err) {
      console.error('Retry upload failed:', session.file.name, err)
      updateFileProgress(uploadId, { status: 'error', error: errorMessage(err, 'Upload failed') }, () => 'partial')
    }
  }

  return (
    <UploadContext.Provider value={{ uploadProgress, setUploadProgress, uploadFiles, uploadPaths: async () => { throw new Error('Local paths can only be uploaded from the desktop app.') }, retryFailedUpload }}>
      {children}
    </UploadContext.Provider>
  )
}

export function useUpload() {
  const context = useContext(UploadContext)
  if (context === undefined) {
    throw new Error('useUpload must be used within an UploadProvider')
  }
  return context
}
