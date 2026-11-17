import { useCallback, useEffect, useState } from 'react'
import { apiFetch, formatBytes } from '@/lib/api'
import { accountLabel, type ConnectedAccount } from '@/lib/accounts'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/drive/PageHeader'

type FileOption = { id: string; name: string; sizeBytes: string }
type JobItem = { id: string; status: string; destinationName: string; bytesTransferred: string; lastError: string | null }
type Job = { id: string; kind: string; status: string; totalItems: number; completedItems: number; failedItems: number; items: JobItem[]; createdAt: string; lastError: string | null }
const selectClass = 'h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-accent'

export function TransfersPage() {
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([])
  const [sourceId, setSourceId] = useState('')
  const [destinationId, setDestinationId] = useState('')
  const [files, setFiles] = useState<FileOption[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [kind, setKind] = useState<'copy' | 'move' | 'replicate'>('copy')
  const [jobs, setJobs] = useState<Job[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const refreshJobs = useCallback(async () => {
    const result = await apiFetch<{ jobs: Job[] }>('/transfers')
    setJobs(result.jobs)
  }, [])
  useEffect(() => {
    void apiFetch<{ accounts: ConnectedAccount[] }>('/connected-accounts').then((result) => setAccounts(result.accounts)).catch((cause) => setError(String(cause)))
    void refreshJobs().catch((cause) => setError(String(cause)))
    const timer = window.setInterval(() => { void refreshJobs().catch(() => undefined) }, 3000)
    return () => window.clearInterval(timer)
  }, [refreshJobs])
  useEffect(() => {
    setSelected([])
    if (!sourceId) { setFiles([]); return }
    void apiFetch<{ files: FileOption[] }>(`/files?accountId=${encodeURIComponent(sourceId)}&limit=1000`)
      .then((result) => setFiles(result.files)).catch((cause) => setError(String(cause)))
  }, [sourceId])

  async function createJob() {
    if (!sourceId || !destinationId || selected.length === 0) return
    setBusy(true); setError('')
    try {
      await apiFetch('/transfers', { method: 'POST', body: JSON.stringify({ sourceAccountId: sourceId, destinationAccountId: destinationId, fileIds: selected, kind }) })
      setSelected([])
      await refreshJobs()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create transfer.') }
    finally { setBusy(false) }
  }

  async function act(id: string, action: 'pause' | 'resume' | 'cancel' | 'retry') {
    try { await apiFetch(`/transfers/${id}/${action}`, { method: 'POST' }); await refreshJobs() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update transfer.') }
  }

  return <div className="grid gap-6 p-6">
    <PageHeader title="Transfers" description="Copy, move, or replicate files between connected accounts. Moves remove the source only after the destination is verified." />
    <section className="grid gap-4 rounded-xl border border-border bg-surface p-5" aria-label="New transfer">
      <h2 className="text-base font-semibold text-text">New transfer</h2>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="grid gap-1 text-sm text-text">From<select className={selectClass} value={sourceId} onChange={(event) => setSourceId(event.target.value)}><option value="">Select account</option>{accounts.map((account) => <option value={account.id} key={account.id}>{accountLabel(account)}</option>)}</select></label>
        <label className="grid gap-1 text-sm text-text">To<select className={selectClass} value={destinationId} onChange={(event) => setDestinationId(event.target.value)}><option value="">Select account</option>{accounts.filter((account) => account.id !== sourceId).map((account) => <option value={account.id} key={account.id}>{accountLabel(account)}</option>)}</select></label>
        <label className="grid gap-1 text-sm text-text">Operation<select className={selectClass} value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="copy">Copy, keep source</option><option value="move">Move, remove source after verification</option><option value="replicate">Replicate once</option></select></label>
      </div>
      <div className="max-h-56 overflow-y-auto rounded-lg border border-border" role="group" aria-label="Files to transfer">
        {files.length ? files.map((file) => <label key={file.id} className="flex cursor-pointer items-center gap-3 border-b border-border px-3 py-2 text-sm text-text last:border-b-0"><input type="checkbox" checked={selected.includes(file.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, file.id] : current.filter((id) => id !== file.id))} /><span className="min-w-0 flex-1 truncate">{file.name}</span><span className="text-muted">{formatBytes(file.sizeBytes)}</span></label>) : <p className="p-4 text-sm text-muted">Choose a source account to see its files.</p>}
      </div>
      <div className="flex justify-end"><Button onClick={() => void createJob()} disabled={busy || !sourceId || !destinationId || sourceId === destinationId || selected.length === 0}>Start {kind}</Button></div>
    </section>
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    <section className="grid gap-3" aria-label="Transfer history"><h2 className="text-base font-semibold text-text">Jobs</h2>{jobs.length ? jobs.map((job) => <article key={job.id} className="rounded-xl border border-border bg-surface p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-medium capitalize text-text">{job.kind} · {job.status.replace('_', ' ')}</p><p className="text-sm text-muted">{job.completedItems}/{job.totalItems} complete · {job.failedItems} failed</p></div><div className="flex gap-2">{job.status === 'running' || job.status === 'queued' ? <Button variant="secondary" onClick={() => void act(job.id, 'pause')}>Pause</Button> : null}{job.status === 'paused' ? <Button variant="secondary" onClick={() => void act(job.id, 'resume')}>Resume</Button> : null}{['failed', 'partial', 'dead_letter'].includes(job.status) ? <Button variant="secondary" onClick={() => void act(job.id, 'retry')}>Retry</Button> : null}{!['completed', 'cancelled'].includes(job.status) ? <Button variant="secondary" onClick={() => void act(job.id, 'cancel')}>Cancel</Button> : null}</div></div>{job.lastError ? <p className="mt-2 text-sm text-danger">{job.lastError}</p> : null}</article>) : <p className="text-sm text-muted">No transfers yet.</p>}</section>
  </div>
}
