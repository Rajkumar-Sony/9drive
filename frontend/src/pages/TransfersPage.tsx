import { useCallback, useEffect, useState } from 'react'
import { apiFetch, authedFetch, formatBytes } from '@/lib/api'
import { accountLabel, type ConnectedAccount } from '@/lib/accounts'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/drive/PageHeader'

type FileOption = { id: string; name: string; sizeBytes: string }
type JobItem = { id: string; status: string; destinationName: string; bytesTransferred: string; lastError: string | null }
type Job = { id: string; kind: string; status: string; totalItems: number; completedItems: number; failedItems: number; items: JobItem[]; createdAt: string; lastError: string | null }
type ReplicationPlan = { id: string; name: string; sourceConnectedAccountId: string; destinationConnectedAccountId: string; status: string; scheduleCron: string | null; nextRunAt: string | null; lastRunAt: string | null }
const scheduleOptions = [
  { value: '', label: 'Manual only' },
  { value: '0 * * * *', label: 'Hourly (UTC)' },
  { value: '0 0 * * *', label: 'Daily at 00:00 UTC' },
  { value: '0 0 * * 1', label: 'Mondays at 00:00 UTC' },
]
const selectClass = 'h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-accent'

export function TransfersPage() {
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([])
  const [sourceId, setSourceId] = useState('')
  const [destinationId, setDestinationId] = useState('')
  const [files, setFiles] = useState<FileOption[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [kind, setKind] = useState<'copy' | 'move' | 'replicate'>('copy')
  const [jobs, setJobs] = useState<Job[]>([])
  const [plans, setPlans] = useState<ReplicationPlan[]>([])
  const [planName, setPlanName] = useState('')
  const [planSchedule, setPlanSchedule] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const refreshJobs = useCallback(async () => {
    const result = await apiFetch<{ jobs: Job[] }>('/transfers')
    setJobs(result.jobs)
  }, [])
  const refreshPlans = useCallback(async () => {
    const result = await apiFetch<{ plans: ReplicationPlan[] }>('/transfers/plans')
    setPlans(result.plans)
  }, [])
  useEffect(() => {
    void apiFetch<{ accounts: ConnectedAccount[] }>('/connected-accounts').then((result) => setAccounts(result.accounts)).catch((cause) => setError(String(cause)))
    void refreshJobs().catch((cause) => setError(String(cause)))
    void refreshPlans().catch((cause) => setError(String(cause)))
    const timer = window.setInterval(() => { void refreshJobs().catch(() => undefined) }, 3000)
    return () => window.clearInterval(timer)
  }, [refreshJobs, refreshPlans])
  useEffect(() => {
    const active = jobs.find((job) => job.status === 'queued' || job.status === 'running')
    if (!active) return
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await authedFetch(`/transfers/${active.id}/events`, { signal: controller.signal, headers: { Accept: 'text/event-stream' } })
        if (!response.ok || !response.body) return
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const frames = buffer.split('\n\n')
          buffer = frames.pop() ?? ''
          for (const frame of frames) {
            const data = frame.split('\n').find((line) => line.startsWith('data: '))
            if (!data) continue
            const progress = JSON.parse(data.slice(6)) as Pick<Job, 'id' | 'status' | 'totalItems' | 'completedItems' | 'failedItems'>
            setJobs((current) => current.map((job) => job.id === progress.id ? { ...job, ...progress } : job))
          }
        }
        if (!controller.signal.aborted) await refreshJobs()
      } catch { /* The list refresh remains available if the stream is interrupted. */ }
    })()
    return () => controller.abort()
  }, [jobs.map((job) => `${job.id}:${job.status}`).join(','), refreshJobs])
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

  async function createPlan() {
    if (!planName.trim() || !sourceId || !destinationId || sourceId === destinationId) return
    setBusy(true); setError('')
    try {
      await apiFetch('/transfers/plans', { method: 'POST', body: JSON.stringify({ name: planName.trim(), sourceAccountId: sourceId, destinationAccountId: destinationId, scheduleCron: planSchedule || null }) })
      setPlanName('')
      await refreshPlans()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create replication plan.') }
    finally { setBusy(false) }
  }

  async function runPlan(id: string) {
    setBusy(true); setError('')
    try { await apiFetch(`/transfers/plans/${id}/run`, { method: 'POST' }); await refreshJobs(); await refreshPlans() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not run replication plan.') }
    finally { setBusy(false) }
  }

  async function updateSchedule(id: string, scheduleCron: string | null) {
    setBusy(true); setError('')
    try {
      await apiFetch(`/transfers/plans/${id}/schedule`, { method: 'PATCH', body: JSON.stringify({ scheduleCron }) })
      await refreshPlans()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update replication schedule.') }
    finally { setBusy(false) }
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
    <section className="grid gap-3 rounded-xl border border-border bg-surface p-5" aria-label="Replication plans">
      <h2 className="text-base font-semibold text-text">Replication plans</h2>
      <p className="text-sm text-muted">Save a source and destination, then run manually or choose an optional UTC schedule. Unchanged files with verified mappings are skipped.</p>
      <div className="flex flex-wrap gap-2"><input className={`${selectClass} min-w-48 flex-1`} aria-label="Replication plan name" placeholder="Plan name" value={planName} onChange={(event) => setPlanName(event.target.value)} /><select className={selectClass} aria-label="New plan schedule" value={planSchedule} onChange={(event) => setPlanSchedule(event.target.value)}>{scheduleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><Button variant="secondary" onClick={() => void createPlan()} disabled={busy || !planName.trim() || !sourceId || !destinationId || sourceId === destinationId}>Save current accounts as plan</Button></div>
      {plans.map((plan) => <div key={plan.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-sm"><div><p className="font-medium text-text">{plan.name}</p><p className="text-muted">{accounts.find((account) => account.id === plan.sourceConnectedAccountId)?.email ?? 'Source'} → {accounts.find((account) => account.id === plan.destinationConnectedAccountId)?.email ?? 'Destination'} · {plan.lastRunAt ? `Last run ${new Date(plan.lastRunAt).toLocaleString()}` : 'Never run'}{plan.status === 'paused' ? ' · Schedule paused after an error' : plan.nextRunAt ? ` · Next ${new Date(plan.nextRunAt).toLocaleString()}` : ''}</p></div><div className="flex flex-wrap gap-2"><select className={selectClass} aria-label={`Schedule for ${plan.name}`} value={plan.scheduleCron ?? ''} disabled={busy} onChange={(event) => void updateSchedule(plan.id, event.target.value || null)}>{scheduleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{plan.status === 'paused' ? <Button variant="secondary" disabled={busy} onClick={() => void updateSchedule(plan.id, plan.scheduleCron)}>Resume schedule</Button> : null}<Button variant="secondary" disabled={busy} onClick={() => void runPlan(plan.id)}>Run now</Button></div></div>)}
    </section>
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    <section className="grid gap-3" aria-label="Transfer history"><h2 className="text-base font-semibold text-text">Jobs</h2>{jobs.length ? jobs.map((job) => <article key={job.id} className="rounded-xl border border-border bg-surface p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-medium capitalize text-text">{job.kind} · {job.status.replace('_', ' ')}</p><p className="text-sm text-muted">{job.completedItems}/{job.totalItems} complete · {job.failedItems} failed</p></div><div className="flex gap-2">{job.status === 'running' || job.status === 'queued' ? <Button variant="secondary" onClick={() => void act(job.id, 'pause')}>Pause</Button> : null}{job.status === 'paused' ? <Button variant="secondary" onClick={() => void act(job.id, 'resume')}>Resume</Button> : null}{['failed', 'partial', 'dead_letter'].includes(job.status) ? <Button variant="secondary" onClick={() => void act(job.id, 'retry')}>Retry</Button> : null}{job.status === 'cancelling' ? <span className="self-center text-sm text-muted">Finishing cancellation…</span> : null}{!['completed', 'cancelled', 'cancelling'].includes(job.status) ? <Button variant="secondary" onClick={() => void act(job.id, 'cancel')}>Cancel</Button> : null}</div></div>{job.lastError ? <p className="mt-2 text-sm text-danger">{job.lastError}</p> : null}</article>) : <p className="text-sm text-muted">No transfers yet.</p>}</section>
  </div>
}
