export type StorageProviderId = 'google_drive' | 's3' | 'onedrive' | 'telegram_bot' | 'telegram_mtproto'
export type StorageProviderOperation =
  | 'quota' | 'upload' | 'download' | 'list' | 'search' | 'createFolder'
  | 'rename' | 'move' | 'copy' | 'delete' | 'resumableUpload'
  | 'multipartUpload' | 'rangeDownload' | 'share'

export interface StorageProviderCapabilities {
  /** null means use the application limit and any upstream runtime limit. */
  maxUploadBytes: bigint | null
  quota: boolean
  upload: boolean
  download: boolean
  list: boolean
  search: boolean
  createFolder: boolean
  rename: boolean
  move: boolean
  copy: boolean
  delete: boolean
  resumableUpload: boolean
  multipartUpload: boolean
  rangeDownload: boolean
  share: boolean
}

const disabled = {
  quota: false, upload: false, download: false, list: false, search: false,
  createFolder: false, rename: false, move: false, copy: false, delete: false,
  resumableUpload: false, multipartUpload: false, rangeDownload: false, share: false,
} satisfies Omit<StorageProviderCapabilities, 'maxUploadBytes'>

export const STORAGE_PROVIDER_CAPABILITIES: Record<StorageProviderId, StorageProviderCapabilities> = {
  google_drive: {
    maxUploadBytes: null, ...disabled, quota: true, upload: true, download: true,
    list: true, createFolder: true, delete: true, resumableUpload: true,
    rangeDownload: true, share: true, copy: true, move: true,
  },
  s3: {
    maxUploadBytes: null, ...disabled, quota: true, upload: true, download: true,
    list: true, delete: true, multipartUpload: true, resumableUpload: true, rangeDownload: true, copy: true, move: true,
  },
  onedrive: { maxUploadBytes: null, ...disabled, quota: true, upload: true, download: true, delete: true, resumableUpload: true, copy: true, move: true },
  telegram_bot: { maxUploadBytes: null, ...disabled },
  telegram_mtproto: { maxUploadBytes: null, ...disabled },
}
