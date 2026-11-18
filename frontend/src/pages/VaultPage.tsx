import { useEffect, useState } from 'react'
import { Download, Eye, KeyRound, LockKeyhole, ShieldCheck, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/drive/PageHeader'
import { useDriveLayoutActions } from '@/layouts/DriveLayout'
import { apiFetch, authedFetch, formatBytes, getApiUrl } from '@/lib/api'
import { getAccessToken } from '@/lib/auth'
import { decryptVaultMetadata, decryptVaultStream, encryptVaultStream, type VaultMetadata } from '@/lib/vault-crypto'

type VaultObject = { fileId: string; name: string; sizeBytes: string; provider: string; createdAt: string; formatVersion: number; encryptedMetadata: string; salt: string; keyWrap: string; encryptionAlgorithm: string }
type OpenFor = { passphrase: string } | { recoveryKey: string }
type SavePickerWindow = Window & { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }> }> }

function encodedEnvelope(value: unknown) {
  return btoa(new TextEncoder().encode(JSON.stringify(value)).reduce((output, byte) => output + String.fromCharCode(byte), ''))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function collectBytes(stream: ReadableStream<Uint8Array>, maximum: number) {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.length
    if (size > maximum) { await reader.cancel(); throw new Error(`Browser preview is limited to ${formatBytes(maximum)}.`) }
    chunks.push(new Uint8Array(next.value))
  }
  return new Blob(chunks.map((chunk) => chunk.buffer as ArrayBuffer))
}

export function VaultPage() {
  const { setBreadcrumb, setHeaderActions } = useDriveLayoutActions()
  const [objects, setObjects] = useState<VaultObject[]>([])
  const [unlocked, setUnlocked] = useState<Record<string, VaultMetadata>>({})
  const [unlockByItem, setUnlockByItem] = useState<Record<string, OpenFor>>({})
  const [passphrase, setPassphrase] = useState('')
  const [passphraseAgain, setPassphraseAgain] = useState('')
  const [recoveryKey, setRecoveryKey] = useState('')
  const [recoveryKeyToSave, setRecoveryKeyToSave] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [accountId, setAccountId] = useState('')
  const [accounts, setAccounts] = useState<{ id: string; provider: string; email: string; displayName?: string | null; status?: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null)

  async function load() {
    const [items, destinations] = await Promise.all([
      apiFetch<{ objects: VaultObject[] }>('/vault/objects'),
      apiFetch<{ accounts: { id: string; provider: string; email: string; displayName?: string | null; status?: string }[] }>('/connected-accounts'),
    ])
    setObjects(items.objects)
    setAccounts(destinations.accounts)
  }

  useEffect(() => {
    setBreadcrumb([{ label: 'Encrypted vault' }])
    setHeaderActions(null)
    load().catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load vault items.'))
  }, [])

  async function unlock(object: VaultObject, secret: OpenFor) {
    setError('')
    try {
      const metadata = await decryptVaultMetadata(object.encryptedMetadata, object.keyWrap, object.salt, secret)
      setUnlocked((current) => ({ ...current, [object.fileId]: metadata }))
      setUnlockByItem((current) => ({ ...current, [object.fileId]: secret }))
      setStatus(`Unlocked ${metadata.name}.`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not unlock this item.') }
  }

  async function upload() {
    if (!file) return setError('Choose a file to place in the vault.')
    if (passphrase !== passphraseAgain) return setError('The passphrases do not match.')
    setBusy(true); setError(''); setStatus('Encrypting on this device…'); setProgress(0)
    try {
      const metadata: VaultMetadata = { name: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size, createdAt: new Date().toISOString() }
      const result = await encryptVaultStream(file.stream(), passphrase, metadata, (bytes) => setProgress(file.size ? 40 + Math.floor((bytes / file.size) * 59) : 99))
      setRecoveryKeyToSave(result.recoveryKey)
      setStatus('Uploading encrypted data…')
      const headers = new Headers({
        Authorization: `Bearer ${getAccessToken()}`,
        'Content-Type': 'application/vnd.oneconnect.vault',
        'X-Vault-Envelope': encodedEnvelope(result.envelope),
        'X-Vault-Cipher-Size': result.cipherSizeBytes.toString(),
      })
      if (accountId) headers.set('X-Vault-Account-Id', accountId)
      const response = await fetch(`${getApiUrl()}/uploads/vault`, { method: 'POST', headers, body: result.stream as BodyInit, duplex: 'half' } as RequestInit & { duplex: 'half' })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { message?: string } | null
        throw new Error(body?.message ?? `Vault upload failed (${response.status}).`)
      }
      const payload = await response.json() as { object: { fileId: string } }
      setFile(null)
      setPassphraseAgain('')
      setStatus('Encrypted file uploaded. Save the recovery key before closing this page.')
      await load()
      setUnlocked((current) => ({ ...current, [payload.object.fileId]: metadata }))
      setUnlockByItem((current) => ({ ...current, [payload.object.fileId]: { passphrase } }))
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Vault upload failed.') }
    finally { setBusy(false); setProgress(100) }
  }

  async function getDecryptedStream(object: VaultObject) {
    const response = await authedFetch(`/files/${encodeURIComponent(object.fileId)}/download`)
    if (!response.ok || !response.body) throw new Error('Could not retrieve the encrypted vault item.')
    const meta = objects.find((item) => item.fileId === object.fileId)!
    const secret = unlockByItem[object.fileId]
    if (!secret) throw new Error('Unlock this vault item again before decrypting it.')
    return decryptVaultStream(response.body, meta.keyWrap, meta.salt, secret)
  }

  async function previewItem(object: VaultObject) {
    const meta = unlocked[object.fileId]
    if (!meta) return
    setError(''); setBusy(true)
    try {
      if (meta.sizeBytes > 1_000_000) throw new Error('Local text preview is limited to files up to 1 MB.')
      const stream = await getDecryptedStream(object)
      const blob = await collectBytes(stream, 1_000_000)
      setPreview({ name: meta.name, text: await blob.text() })
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not preview this item.') }
    finally { setBusy(false) }
  }

  async function downloadItem(object: VaultObject) {
    const meta = unlocked[object.fileId]
    if (!meta) return
    setError(''); setBusy(true)
    let writer: { write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> } | undefined
    try {
      const stream = await getDecryptedStream(object)
      const picker = (window as SavePickerWindow).showSaveFilePicker
      if (picker) writer = await picker({ suggestedName: meta.name }).then((handle) => handle.createWritable())
      if (!writer && meta.sizeBytes > 100_000_000) throw new Error('For files larger than 100 MB, use a browser that supports secure streaming downloads.')
      const reader = stream.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.length
        if (size > meta.sizeBytes) throw new Error('Decrypted data exceeds its authenticated size.')
        if (writer) await writer.write(next.value)
        else chunks.push(next.value)
      }
      if (size !== meta.sizeBytes) throw new Error('Decrypted data does not match its authenticated size.')
      if (writer) await writer.close()
      else {
        const url = URL.createObjectURL(new Blob(chunks.map((chunk) => new Uint8Array(chunk).buffer as ArrayBuffer), { type: meta.mimeType }))
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = meta.name; anchor.click()
        URL.revokeObjectURL(url)
      }
      setStatus(`Downloaded ${meta.name} after local decryption.`)
    } catch (cause) {
      await writer?.abort().catch(() => undefined)
      setError(cause instanceof Error ? cause.message : 'Could not download this item.')
    } finally { setBusy(false) }
  }

  const storageAccounts = accounts.filter((account) => account.status === 'connected')

  return <>
    <PageHeader title="Encrypted vault" description="Files are encrypted on this device before they leave it. The server stores ciphertext and encrypted metadata only." actions={Object.keys(unlocked).length ? <Button variant="secondary" onClick={() => { setUnlocked({}); setUnlockByItem({}); setPassphrase(''); setRecoveryKey(''); setPreview(null); setStatus('Vault locked.') }}><LockKeyhole className="h-4 w-4" />Lock vault</Button> : null} />
    <div className="mx-auto grid max-w-5xl gap-5">
      <Card className="grid gap-4 p-5">
        <div className="flex items-start gap-3"><span className="rounded-xl bg-accent/10 p-2 text-accent"><ShieldCheck className="h-5 w-5" /></span><div><h2 className="font-semibold text-text">Add to your vault</h2><p className="mt-1 text-sm text-muted">Use a strong passphrase. A separate recovery key is generated once for each item.</p></div></div>
        <label className="grid gap-1 text-sm">File<input type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} className="block w-full rounded-lg border border-border bg-bg px-3 py-2 text-text file:mr-3 file:rounded-md file:border-0 file:bg-hover file:px-3 file:py-1.5 file:text-text" /></label>
        <div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm">Vault passphrase<Input type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} minLength={12} /></label><label className="grid gap-1 text-sm">Confirm passphrase<Input type="password" autoComplete="new-password" value={passphraseAgain} onChange={(event) => setPassphraseAgain(event.target.value)} minLength={12} /></label></div>
        <label className="grid gap-1 text-sm">Store encrypted data in<select className="h-10 rounded-lg border border-border bg-bg px-3 text-sm text-text" value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">Choose automatically</option>{storageAccounts.map((account) => <option key={account.id} value={account.id}>{account.displayName || account.email} · {account.provider}</option>)}</select></label>
        {busy && status.startsWith('Encrypting') ? <div className="h-2 overflow-hidden rounded-full bg-hover"><div className="h-full bg-accent transition-[width]" style={{ width: `${progress}%` }} /></div> : null}
        <div className="flex flex-wrap items-center gap-3"><Button onClick={() => void upload()} disabled={busy || !file || passphrase.length < 12 || passphraseAgain.length < 12}><Upload className="h-4 w-4" />{busy ? status : 'Encrypt and upload'}</Button><span className="text-xs text-muted">{file ? `${file.name} · ${formatBytes(file.size)}` : 'Choose one file'}</span></div>
      </Card>

      {recoveryKeyToSave ? <Card className="border-warning/50 p-5"><h2 className="flex items-center gap-2 font-semibold text-text"><KeyRound className="h-4 w-4 text-warning" />Save this recovery key now</h2><p className="mt-2 text-sm text-muted">This key is shown only once. Anyone with it can decrypt this item. Keep it somewhere private and separate from your account.</p><code className="mt-3 block break-all rounded-lg bg-bg p-3 text-sm text-text">{recoveryKeyToSave}</code><div className="mt-3 flex gap-2"><Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(recoveryKeyToSave)}>Copy key</Button><Button onClick={() => setRecoveryKeyToSave('')}>I saved it</Button></div></Card> : null}

      <Card className="overflow-hidden"><div className="flex flex-wrap items-end justify-between gap-3 border-b border-border p-5"><div><h2 className="font-semibold text-text">Vault items</h2><p className="mt-1 text-sm text-muted">Names and file details stay encrypted until you unlock each item.</p></div><Button variant="secondary" onClick={() => { setError(''); void load().catch((cause) => setError(String(cause))) }}>Refresh</Button></div>
        <div className="grid gap-3 p-4">
          {objects.length === 0 ? <div className="grid justify-items-center gap-2 py-12 text-center"><LockKeyhole className="h-7 w-7 text-muted" /><p className="font-medium text-text">Your vault is empty</p><p className="text-sm text-muted">Choose a file above to encrypt it on this device.</p></div> : objects.map((object) => {
            const meta = unlocked[object.fileId]
            return <div key={object.fileId} className="grid gap-3 rounded-xl border border-border p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"><div className="min-w-0"><p className="truncate font-medium text-text">{meta?.name ?? 'Locked encrypted item'}</p><p className="mt-1 text-xs text-muted">{formatBytes(object.sizeBytes)} encrypted · {object.provider} · {new Date(object.createdAt).toLocaleDateString()}</p></div><div className="flex flex-wrap gap-2">{meta ? <><Button size="sm" variant="secondary" onClick={() => void previewItem(object)} disabled={busy}><Eye className="h-4 w-4" />Preview</Button><Button size="sm" onClick={() => void downloadItem(object)} disabled={busy}><Download className="h-4 w-4" />Decrypt and save</Button></> : <div className="flex flex-wrap gap-2"><Input aria-label="Vault passphrase" placeholder="Passphrase" type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /><Input aria-label="Recovery key" placeholder="Recovery key (optional)" value={recoveryKey} onChange={(event) => setRecoveryKey(event.target.value)} /><Button size="sm" variant="secondary" onClick={() => void unlock(object, recoveryKey ? { recoveryKey: recoveryKey.trim() } : { passphrase })}><LockKeyhole className="h-4 w-4" />Unlock</Button></div>}</div></div>
          })}
        </div>
      </Card>

      {preview ? <Card className="grid gap-3 p-5"><div className="flex items-center justify-between gap-2"><h2 className="font-semibold text-text">Local preview · {preview.name}</h2><Button variant="secondary" size="sm" onClick={() => setPreview(null)}>Close</Button></div><pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-bg p-4 text-sm text-text">{preview.text}</pre></Card> : null}
      {status ? <p role="status" className="text-sm text-muted">{status}</p> : null}
      {error ? <p role="alert" className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">{error}</p> : null}
      <p className="text-xs text-muted">The vault is separate from ordinary storage. Losing both your passphrase and recovery key makes the original file unrecoverable.</p>
    </div>
  </>
}
