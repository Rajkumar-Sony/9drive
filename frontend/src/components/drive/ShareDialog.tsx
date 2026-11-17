import { useEffect, useState, type FormEvent } from 'react'
import { Check, Copy, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { apiFetch } from '@/lib/api'
import type { FileItem } from '@/types/drive'

type Expiry = 'never' | '1d' | '7d' | '30d'
type SentInvite = { id: string; email: string; role: string; status: string; targetType: string; targetId: string }

const expiryOptions: { value: Expiry; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: '1d', label: '1 day' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
]
const selectClass = 'h-9 w-full rounded-lg border border-border bg-bg px-3 text-[13px] text-text outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/25'
const roleSelectClass = selectClass.replace('w-full', 'w-auto')

function expiryFor(expiresAt: string | null): Expiry {
  if (!expiresAt) return 'never'
  const days = (new Date(expiresAt).getTime() - Date.now()) / 86_400_000
  if (days <= 1.5) return '1d'
  if (days <= 8) return '7d'
  return '30d'
}

export function ShareDialog({ file, open, onClose, onChanged }: { file: FileItem | null; open: boolean; onClose: () => void; onChanged?: () => void }) {
  const fileId = file?.id ?? null
  const [url, setUrl] = useState<string | null>(null)
  const [expiry, setExpiry] = useState<Expiry>('never')
  const [passwordProtected, setPasswordProtected] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const [people, setPeople] = useState<SentInvite[]>([])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'viewer' | 'editor'>('viewer')
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState('')

  async function loadPeople() {
    if (!fileId) return
    const data = await apiFetch<{ sent: SentInvite[] }>('/invites')
    setPeople(data.sent.filter((invite) => invite.targetType === 'file' && invite.targetId === fileId))
  }

  useEffect(() => {
    if (!open || !fileId) return
    let cancelled = false
    setUrl(null)
    setExpiry('never')
    setPasswordProtected(false)
    setNewPassword('')
    setConfirmPassword('')
    setCopied(false)
    setError('')
    setPeople([])
    setEmail('')
    setRole('viewer')
    setInviteError('')
    apiFetch<{ shares: { url: string | null; expiresAt: string | null; passwordProtected: boolean; file: { id: string } }[] }>('/files/shared-links')
      .then((data) => {
        if (cancelled) return
        const share = data.shares.find((item) => item.file.id === fileId)
        if (share?.url) {
          setUrl(share.url)
          setExpiry(expiryFor(share.expiresAt))
          setPasswordProtected(Boolean(share.passwordProtected))
        }
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Failed to load sharing settings'))
    loadPeople().catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [open, fileId])

  async function createOrUpdateLink(nextExpiry: Expiry | undefined, password?: string | null) {
    if (!fileId) return
    setBusy(true)
    setError('')
    try {
      const data = await apiFetch<{ url: string; passwordProtected: boolean }>(`/files/${fileId}/share`, { method: 'POST', body: JSON.stringify({ ...(nextExpiry ? { expiresIn: nextExpiry } : {}), ...(password !== undefined ? { password } : {}) }) })
      setUrl(data.url)
      if (nextExpiry) setExpiry(nextExpiry)
      setPasswordProtected(data.passwordProtected)
      setNewPassword('')
      setConfirmPassword('')
      onChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update the link')
    } finally {
      setBusy(false)
    }
  }

  async function toggleLink(on: boolean) {
    if (!on) {
      if (!fileId) return
      setBusy(true)
      setError('')
      try {
        await apiFetch(`/files/${fileId}/share`, { method: 'DELETE' })
        setUrl(null)
        setPasswordProtected(false)
        setCopied(false)
        onChanged?.()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to turn off the link')
      } finally {
        setBusy(false)
      }
      return
    }
    if (newPassword && (newPassword.length < 12 || newPassword !== confirmPassword)) { setError('Use at least 12 characters and matching passwords.'); return }
    await createOrUpdateLink(expiry, newPassword || undefined)
  }

  async function updatePassword(password: string | null) {
    if (!fileId || !url) return
    if (password !== null && (password.length < 12 || password !== confirmPassword)) { setError('Use at least 12 characters and matching passwords.'); return }
    await createOrUpdateLink(undefined, password)
  }

  async function copy() {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setError('Could not copy the link. Select it and copy manually.')
    }
  }

  async function invite(event: FormEvent) {
    event.preventDefault()
    if (!fileId) return
    setInviting(true)
    setInviteError('')
    try {
      await apiFetch('/invites', { method: 'POST', body: JSON.stringify({ email, role, targetType: 'file', targetId: fileId }) })
      setEmail('')
      setRole('viewer')
      window.dispatchEvent(new Event('oneconnect:invites-changed'))
      await loadPeople()
    } catch (e) {
      setInviteError(e instanceof Error ? e.message : 'Failed to send invite')
    } finally {
      setInviting(false)
    }
  }

  async function removePerson(id: string) {
    try {
      await apiFetch(`/invites/${id}`, { method: 'DELETE' })
      setPeople((current) => current.filter((person) => person.id !== id))
      window.dispatchEvent(new Event('oneconnect:invites-changed'))
    } catch (e) {
      setInviteError(e instanceof Error ? e.message : 'Failed to remove access')
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={file ? `Share "${file.name}"` : 'Share'} width={520} footer={<Button variant="secondary" onClick={onClose}>Done</Button>}>
      <div className="grid gap-5">
        <section className="grid gap-3" aria-label="Public link">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-text">Public link</p>
              <p className="text-[12px] text-muted">{passwordProtected ? 'Anyone with the link and password can view.' : 'Anyone with the link can view, no Google sign-in needed.'}</p>
            </div>
            <Switch checked={url !== null} onChange={(on) => { if (!busy) void toggleLink(on) }} label="Public link" />
          </div>
          {url !== null ? (
            <>
              <div className="flex items-center gap-2">
                <Input value={url} readOnly aria-label="Share link" onFocus={(event) => event.currentTarget.select()} />
                <Button variant="secondary" onClick={copy}>
                  {copied ? <Check className="h-4 w-4" strokeWidth={1.5} /> : <Copy className="h-4 w-4" strokeWidth={1.5} />}
                  {copied ? 'Copied' : 'Copy link'}
                </Button>
              </div>
              <label className="grid gap-1.5 text-[13px] font-medium text-text">
                Link expires
                <select className={selectClass} value={expiry} disabled={busy} onChange={(event) => void createOrUpdateLink(event.target.value as Expiry)}>
                  {expiryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            </>
          ) : null}
          <div className="grid gap-2 rounded-lg border border-border p-3">
            <p className="text-[13px] font-medium text-text">Password protection {passwordProtected ? '· On' : '· Off'}</p>
            <p className="text-[12px] text-muted">Optional. Share the password separately from the link. At least 12 characters.</p>
            <Input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder={passwordProtected ? 'New password' : 'Set a password'} aria-label="Share password" />
            <Input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Confirm password" aria-label="Confirm share password" />
            {url !== null ? <div className="flex gap-2"><Button variant="secondary" disabled={busy || !newPassword} onClick={() => void updatePassword(newPassword)}>{passwordProtected ? 'Change password' : 'Protect link'}</Button>{passwordProtected ? <Button variant="ghost" disabled={busy} onClick={() => void updatePassword(null)}>Remove password</Button> : null}</div> : null}
          </div>
          {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
        </section>

        <section className="grid gap-3 border-t border-border pt-4" aria-label="People">
          <p className="text-[13px] font-medium text-text">Invite people</p>
          <form onSubmit={invite} className="flex flex-wrap items-center gap-2">
            <Input type="email" className="min-w-0 flex-1 basis-48" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="member@example.com" aria-label="Email address" required />
            <select className={roleSelectClass} value={role} onChange={(event) => setRole(event.target.value as 'viewer' | 'editor')} aria-label="Role">
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </select>
            <Button type="submit" disabled={inviting}>{inviting ? 'Inviting...' : 'Invite'}</Button>
          </form>
          {inviteError ? <p role="alert" className="text-[13px] text-danger">{inviteError}</p> : null}
          {people.length > 0 ? (
            <ul className="grid gap-1">
              {people.map((person) => (
                <li key={person.id} className="flex min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-[13px]">
                  <span className="min-w-0 flex-1 truncate text-text">{person.email}</span>
                  <span className="shrink-0 text-[12px] capitalize text-muted">{person.role}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${person.email}`}
                    onClick={() => void removePerson(person.id)}
                    className="shrink-0 rounded-md text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <X className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <p className="text-[12px] text-subtle">Sharing here doesn’t change who can open the file in Google Drive.</p>
      </div>
    </Dialog>
  )
}
