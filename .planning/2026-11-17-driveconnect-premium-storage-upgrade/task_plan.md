# DriveConnect Premium Storage Upgrade

## Goal
Implement the approved provider, upload, transfer, job, folder-upload, Telegram, OneDrive, and zero-knowledge vault design in the current project without breaking existing Google Drive, S3, desktop, PWA, or sharing behavior.

## Global constraints
- Preserve pre-existing uncommitted branding files and other unrelated changes.
- Keep MySQL authoritative; deploy workers separately; do not add Redis.
- Only implement Google Drive, OneDrive, S3-compatible, Telegram Bot API, and Telegram MTProto providers.
- Keep normal file behavior backward compatible; vault is a separate mode and never sends plaintext or keys to the backend.
- Telegram uses user-managed Bot API credentials and separately encrypted MTProto sessions. Local Bot API base URL is server-configured, never arbitrary per-user input.
- Moves verify and persist destination integrity before deleting source. Conflicts default to keep-both and retries use stable mappings.
- Use reference repositories for patterns only; do not copy code. iLyeseia is Apache-2.0; BlackOctal has no LICENSE file.
- TDD for implementation; prove focused failure before production changes and run fresh verification before claiming completion.

## Tasks
1. **Provider contract and durable storage model** — define provider capability/upload/transfer contracts, additive Prisma models for provider sessions, jobs, job items, replication mappings, and vault metadata; preserve existing providers and routes. Add contract/state-machine tests first.
2. **MySQL worker foundation** — separate worker entrypoint and container, atomic `FOR UPDATE SKIP LOCKED` claims, leases, heartbeat, fencing, retries, pause/resume/cancel, dead-letter/manual recovery, idempotency. Test multi-worker claims and crash recovery.
3. **Provider integrations** — OneDrive delegated OAuth/session uploads; Telegram Bot and MTProto connection/session handling with capability limits; retain Google/S3 adapters; capability-gated operations and account UI. Use test doubles/test DC only.
4. **Upload and folder flows** — common durable upload sessions; browser S3 presigned multipart/reconciliation/cleanup; Google and OneDrive resumable sessions; recursive PWA/Tauri folder selection with path safety and structure preservation. Test retries, expired sessions, and unsafe paths.
5. **Copy, move, replication, and UI** — streamed verification, conflict engine, stable source-to-destination mappings, optional schedules defaulting to manual, authenticated APIs, SSE progress, responsive transfer dashboard. Test conflict races and source deletion invariants.
6. **Zero-knowledge vault** — libsodium.js streaming encryption, passphrase/recovery-key wrapping, encrypted metadata, local preview, explicit conversion flows, ciphertext-only server transfer, direct-client plaintext export to Google/OneDrive/S3, Telegram plaintext-export block. Add crypto/privacy tests before UI integration.
7. **Hardening and acceptance** — CI, migrations, existing regression suites, provider/job/security/folder/vault E2E coverage, final fresh code review, and update this ledger.

## Interfaces and dependencies
- Provider contracts and resumable upload-session shape feed workers, API routes, and upload UI.
- Job/job-item persistence feeds worker orchestration, SSE, and dashboard; MySQL is authoritative.
- Vault metadata and crypto framing feed encrypted uploads, previews, and opaque transfer verification.
- Telegram Bot is limited by configured Bot API mode; MTProto is rate-limited, session-scoped, and uses its own client credentials.

## Current status
- Phase: Tasks 2–5 in progress; Tasks 6–7 pending. OneDrive code is present but not live-authorized; Telegram adapters remain pending.
- Approved detailed plan: conversation turn immediately before implementation request.
- Base checkout: `/Users/pb0595/Documents/Projects/SaaS/oneconnect`.
- See progress.md for completed code and verification; database-backed runtime checks are pending.
