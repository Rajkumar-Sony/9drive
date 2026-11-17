import { runTransferWorker } from './modules/transfers/transfer.worker.js'

runTransferWorker().catch((error) => {
  console.error('[transfer-worker] stopped', error)
  process.exitCode = 1
})
