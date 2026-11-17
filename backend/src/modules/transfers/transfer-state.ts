export type TransferJobStatus = 'queued' | 'running' | 'paused' | 'cancelling' | 'completed' | 'partial' | 'failed' | 'dead_letter' | 'cancelled'

const transitions: Record<TransferJobStatus, readonly TransferJobStatus[]> = {
  queued: ['running', 'paused', 'cancelled'],
  running: ['queued', 'paused', 'cancelling', 'cancelled', 'completed', 'partial', 'failed', 'dead_letter'],
  paused: ['queued', 'cancelled'],
  cancelling: ['cancelled', 'partial', 'failed'],
  completed: [],
  partial: ['queued', 'paused', 'cancelled'],
  failed: ['queued', 'cancelled'],
  dead_letter: ['queued', 'cancelled'],
  cancelled: [],
}

export function canTransitionTransferJob(from: string, to: TransferJobStatus): boolean {
  return (transitions[from as TransferJobStatus] ?? []).includes(to)
}

export function assertTransferJobTransition(from: string, to: TransferJobStatus): void {
  if (!canTransitionTransferJob(from, to)) throw new Error(`Invalid transfer job transition: ${from} -> ${to}`)
}

export function terminalTransferStatus(status: string): boolean {
  return status === 'completed' || status === 'dead_letter' || status === 'cancelled'
}
