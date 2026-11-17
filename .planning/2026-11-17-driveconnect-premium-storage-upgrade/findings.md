# Findings — DriveConnect Premium Storage Upgrade

## Existing architecture
- Backend is Express 5 + TypeScript + Prisma + MySQL 8.4; frontend is React/Vite and desktop is Tauri/Rust.
- Existing `StorageProvider` is currently a small Google/S3 interface for quota, stream response, and delete.
- `File.provider` and connected-account provider IDs are strings; current schema has `UploadSession` with Google resumable URL and S3 multipart ID/object key.
- Browser Google upload is resumable; browser S3 falls back to one request. Desktop Google and S3 use direct resumable/multipart transfers.
- Backend has no durable queue/worker. Docker Compose runs MySQL, API, and frontend only.
- Existing folder model supports virtual and account-specific folder mirrors; browser and desktop file pickers currently select files only.
- Current API mounts auth, accounts, uploads, files, folders, sharing, and audit modules at the root.
- Existing Google/S3 credentials and share tokens use `TOKEN_ENCRYPTION_KEY`; vault crypto is not present.
- Backend tests are Node `.mjs`; frontend tests use Node test; desktop uses Rust tests. Integration test setup is limited and partly opt-in.

## User decisions
- Telegram scope includes both Bot API storage and MTProto user-session storage; optional notifications are opt-in and separate.
- Vault is separate, optional, zero-knowledge, and must preserve normal-file behavior.
- Vault ciphertext can be moved/copied server-side; plaintext export is client-only and is blocked for Telegram server adapters.
- MySQL-backed, separately deployable worker; no Redis unless later performance evidence justifies it.
- Conflict default is Keep Both with stable retry naming; checksum duplicates may be skipped; overwrite is explicit and safeguarded.
- Providers in scope: Google Drive, Microsoft OneDrive, S3-compatible, Telegram Bot API, Telegram MTProto.
- Existing uncommitted branding changes must remain untouched.

## External API/security constraints verified
- Telegram hosted Bot API currently documents 50 MB upload and 20 MB download; Local Bot API documents 2,000 MB upload and unlimited download.
- Telegram Bot API message deletion has age and permission restrictions; move must be capability-checked.
- Telegram MTProto file parts have protocol constraints and may expire; handle flood waits and reauthentication without claiming unlimited durable resume.
- MySQL 8.4 documents `SKIP LOCKED` as applicable to queue-like row claiming.
- Google Drive and Microsoft Graph have distinct resumable-session rules; S3 multipart must reconcile parts and complete/abort explicitly.
- libsodium.js secretstream and Argon2id selected for client-side vault design; GramJS selected for MTProto after deployment-owned Telegram API credentials are configured.
- iLyeseia source license is Apache-2.0; BlackOctal has no LICENSE file found. No source code will be copied.

## Rulings
- Use a common capability contract with provider-specific upload/session implementations; do not force providers to pretend they support unsupported operations.
- Use MySQL as source of truth for both jobs and checkpoints; use lease generation/fencing to make multiple worker containers safe.
- Keep interactive replacements out of unattended recurring runs; they transition to `needs_input`.
- Use a client-keyed identity for vault duplicate checks; no plaintext digest reaches the backend.
