import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useParams } from 'react-router-dom'
import { Download, ExternalLink, FileArchive, FileText, ImageIcon, Play, Table2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { getApiUrl, apiFetch, ApiError, formatBytes, formatDate } from '@/lib/api'
import { createPlyr, ensurePlyr } from '@/lib/plyr'
import { getPreviewKind, isSpreadsheetMimeType, officeViewerUrl } from '@/lib/preview'

type PublicFile = { name: string; mimeType: string; sizeBytes: string; createdAt: string; passwordProtected?: boolean }

function fileIcon(file: PublicFile, kind: ReturnType<typeof getPreviewKind>) {
  if (kind === 'image') return <ImageIcon className="h-4 w-4" strokeWidth={1.5} />
  if (kind === 'video') return <Play className="h-4 w-4" strokeWidth={1.5} />
  if (isSpreadsheetMimeType(file.mimeType)) return <Table2 className="h-4 w-4" strokeWidth={1.5} />
  if (kind === 'document' || kind === 'office') return <FileText className="h-4 w-4" strokeWidth={1.5} />
  return <FileArchive className="h-4 w-4" strokeWidth={1.5} />
}

function UnsupportedPreview({ file, downloadUrl }: { file: PublicFile; downloadUrl: string }) {
  return (
    <EmptyState
      icon={<FileArchive className="h-4 w-4" strokeWidth={1.5} />}
      title="Preview not available"
      description={`${file.name} cannot be previewed in the browser. Download it to open it locally.`}
      action={<a href={downloadUrl} download><Button><Download className="h-4 w-4" strokeWidth={1.5} />Download</Button></a>}
    />
  )
}

export function PublicFilePage({ embed = false }: { embed?: boolean }) {
  const { token } = useParams()
  const [file, setFile] = useState<PublicFile | null>(null)
  const [failed, setFailed] = useState(false)
  const [locked, setLocked] = useState(false)
  const [password, setPassword] = useState('')
  const [unlockError, setUnlockError] = useState('')
  const [unlocking, setUnlocking] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const previewUrl = `${getApiUrl()}/public/files/${token}/preview`
  const downloadUrl = `${getApiUrl()}/public/files/${token}/download`
  const kind = getPreviewKind(file?.mimeType)

  useEffect(() => {
    setFailed(false)
    setFile(null)
    setLocked(false)
    apiFetch<{ file: PublicFile }>(`/public/files/${token}`, { skipAuth: true, credentials: 'include' })
      .then((data) => { setFile(data.file); setLocked(false) })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === 'SHARE_PASSWORD_REQUIRED') { setLocked(true); return }
        setFile(null)
        setFailed(true)
      })
  }, [token])

  useEffect(() => {
    document.title = file ? `${file.name} | oneconnect` : 'Shared file | oneconnect'
    return () => {
      document.title = 'oneconnect'
    }
  }, [file])

  useEffect(() => {
    if (kind !== 'video' || !videoRef.current) return undefined
    let disposed = false
    let player: { destroy: () => void } | null = null

    ensurePlyr().then(() => {
      if (disposed || !videoRef.current) return
      player = createPlyr(videoRef.current)
    }).catch(() => undefined)

    return () => {
      disposed = true
      player?.destroy()
    }
  }, [kind, previewUrl])

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!token || unlocking) return
    setUnlocking(true)
    setUnlockError('')
    try {
      await apiFetch(`/public/files/${token}/unlock`, { method: 'POST', skipAuth: true, credentials: 'include', body: JSON.stringify({ password }) })
      const data = await apiFetch<{ file: PublicFile }>(`/public/files/${token}`, { skipAuth: true, credentials: 'include' })
      setFile({ ...data.file, passwordProtected: true })
      setLocked(false)
      setPassword('')
    } catch (error) {
      setUnlockError(error instanceof Error ? error.message : 'Could not unlock this file.')
    } finally {
      setUnlocking(false)
    }
  }

  if (locked) return <main className="flex min-h-screen items-center justify-center bg-surface p-6 text-text"><form onSubmit={submitPassword} className="grid w-full max-w-sm gap-4 rounded-xl border border-border bg-bg p-6"><h1 className="text-lg font-semibold">Password-protected file</h1><p className="text-sm text-muted">Enter the password provided by the person who shared this file.</p><label className="grid gap-1 text-sm">Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required className="rounded-lg border border-border bg-surface p-2" /></label>{unlockError ? <p role="alert" className="text-sm text-danger">{unlockError}</p> : null}<Button type="submit" disabled={unlocking}>{unlocking ? 'Unlocking…' : 'Unlock file'}</Button></form></main>

  if (failed) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-surface p-6">
        <EmptyState icon={<FileArchive className="h-4 w-4" strokeWidth={1.5} />} title="Shared file not found" description="The link may be expired, disabled, or deleted." />
      </main>
    )
  }

  if (!file) {
    return <main className="flex min-h-screen items-center justify-center bg-surface text-[13px] text-muted">Loading shared file...</main>
  }

  const preview = (
    <div className="flex h-full w-full items-center justify-center">
      {kind === 'image' ? <img src={previewUrl} alt={file.name} className="max-h-full max-w-full object-contain" /> : null}
      {kind === 'video' ? <div className="shared-video-shell"><video ref={videoRef} controls playsInline preload="metadata"><source src={previewUrl} type={file.mimeType} /></video></div> : null}
      {kind === 'document' ? <iframe src={previewUrl} title={file.name} className="h-full w-full border-0 bg-bg" /> : null}
      {kind === 'office' && !file.passwordProtected ? <iframe src={officeViewerUrl(previewUrl)} title={file.name} className="h-full w-full border-0 bg-bg" /> : null}
      {kind === 'office' && file.passwordProtected ? <UnsupportedPreview file={file} downloadUrl={downloadUrl} /> : null}
      {!kind ? <UnsupportedPreview file={file} downloadUrl={downloadUrl} /> : null}
    </div>
  )

  if (embed) {
    return <main className="h-screen overflow-hidden bg-surface">{preview}</main>
  }

  return (
    <main className="flex h-screen flex-col bg-surface text-text">
      <header className="flex h-[60px] shrink-0 items-center justify-between gap-3 border-b border-border bg-bg px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted">
            {fileIcon(file, kind)}
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-text">{file.name}</h1>
            <p className="truncate text-xs text-muted tabular-nums">{formatBytes(file.sizeBytes)} · shared {formatDate(file.createdAt)}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a href={`/public/files/${token}/embed`} target="_blank" rel="noreferrer" className="hidden sm:block">
            <Button variant="ghost"><ExternalLink className="h-4 w-4" strokeWidth={1.5} />Embed</Button>
          </a>
          <a href={downloadUrl} download>
            <Button><Download className="h-4 w-4" strokeWidth={1.5} />Download</Button>
          </a>
        </div>
      </header>

      <section className="min-h-0 flex-1 p-3 sm:p-6">
        <div className="h-full w-full overflow-hidden rounded-xl border border-border bg-bg">
          {preview}
        </div>
      </section>

      <footer className="shrink-0 pb-4 text-center text-xs text-subtle">Shared with oneconnect</footer>
    </main>
  )
}
