import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { CheckCircle, XCircle } from 'lucide-react'
import { AuthShell } from '@/components/auth/AuthShell'

export function GoogleConnectedPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const status = params.get('status') ?? 'success'
  const provider = params.get('provider') === 'onedrive' ? 'OneDrive' : 'Google Drive'
  const ok = status === 'success'

  useEffect(() => {
    window.opener?.postMessage({ type: 'GOOGLE_CONNECTED', status, provider }, window.location.origin)
    const timer = window.setTimeout(() => {
      if (window.opener) window.close()
      else navigate('/quota')
    }, 800)
    return () => window.clearTimeout(timer)
  }, [navigate, status, provider])

  return (
    <AuthShell>
      <div className="text-center">
        {ok ? <CheckCircle className="mx-auto h-8 w-8 text-drive" strokeWidth={1.5} /> : <XCircle className="mx-auto h-8 w-8 text-danger" strokeWidth={1.5} />}
        <h1 className="mt-4 text-lg font-semibold text-text">{ok ? `${provider} connected` : 'Connection failed'}</h1>
        <p className="mt-1 text-[13px] text-muted">{ok ? 'This window will close automatically.' : 'Close this window and try again.'}</p>
      </div>
    </AuthShell>
  )
}
