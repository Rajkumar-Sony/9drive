# Progress Log — DriveConnect Premium Storage Upgrade

## Session 2026-11-17
- Started implementation from the approved plan.
- Re-read repository state and preserved unrelated branding work.
- Loaded execution, TDD, and verification skills.
- Added provider capability contracts and verified Google/S3 adapters.
- Added additive Prisma schema and SQL migration for transfer jobs, replication plans, upload session metadata, and vault metadata.
- Added MySQL transfer worker with claims, leases, fencing, retries, and copy/move processing for existing Google Drive and S3 accounts.
- Added authenticated transfer API and a transfer dashboard for copy, move, and one-time replication.
- Added browser S3 multipart proxy uploads with persisted sessions, part reconciliation, and retries.
- Added web folder selection with path validation and nested folder creation before upload.
- Added Google transfer marker lookup so a worker retry can reuse a prior destination object.
- Added OneDrive OAuth configuration/connection, token refresh, quota, server transfer adapter, and browser upload session handling.
- Rebuilt and restarted the local API, frontend, and transfer worker; health endpoint returns OK.

## Verification
| Area | Command/evidence | Status |
|---|---|---|
| Baseline repository state | `git status --short`, `git diff --stat` | Checked; unrelated logo/brand files preserved |
| Provider and transfer state tests | `node --test tests/storage-provider-capabilities.test.mjs tests/transfer-state.test.mjs` | 4 pass |
| Backend and frontend builds | `npm run build` in each package | Pass |
| Prisma schema | `npx prisma validate` | Pass |
| Migration runtime | `docker compose run --rm --build backend npx prisma migrate deploy` | Applied successfully to local MySQL |
| Full backend suite | `npm test` | 13 pass, 11 skipped because test DB/fixture not configured |
| Worker empty claim | One-shot worker in local Compose database | Exited successfully |
| Running app | `docker compose up -d --build backend transfer-worker frontend`; `/health` | All services running, API healthy |

## Errors and rulings
- First capability test exposed and fixed a provider registry circular import.
- Transfer route TypeScript check exposed and fixed an obsolete cancelling branch.
- OneDrive account authorization with real Microsoft credentials is unverified; imported OneDrive browsing is pending.
- Telegram Bot and MTProto, desktop folder upload, scheduled replication, SSE, vault crypto/UI, and full integration/security coverage remain pending.

## Master Test checkpoint
- Found and fixed a move completion bug: a worker that lost its lease could mark an uploaded item completed without removing the source.
- Backend unit suite: 13 passed, 11 skipped; frontend unit files: 8 passed. The frontend package has no `test` script, so the files were run with `node --test tests/*.test.ts`.
- Unauthenticated `GET /transfers` and `POST /transfers` both returned 401. Local API health and migration status passed.
- Master Test result remains **NOT READY**: real Google/S3/OneDrive transfer workflows, browser multipart/folder flows, job crash recovery, and security/E2E coverage have not been exercised; requested Telegram, MTProto, desktop folder upload, scheduled replication, SSE, and vault work is still incomplete.

## Session 2026-11-18
- Added durable replication-plan create/list/manual-run endpoints, job-plan linkage migration, authenticated SSE progress, and plan controls on the transfer dashboard.
- Closed a crash-recovery gap: retrying an already uploaded replication item now restores its mapping before completion, and refuses to delete a move source when its recorded destination row is absent.
- A retried move now streams the recorded destination back through a bounded SHA-256/size check before source deletion. This guards against a missing or altered remote object after a crash; it still needs a live-provider failure test.
- Rechecked provider connection/capabilities when running a saved plan; no-change runs finish immediately.
- Backend build and 13 unit tests passed; 11 database-dependent tests remain skipped. Frontend build passed. Local MySQL accepted migration `20261118090000_transfer_replication_plan_link`; API health and frontend HTTP checks passed after rebuilding containers.
- Frontend dependency audit currently reports five high advisories through Vite transitive packages. Compatible mitigation and runtime exposure need review.
- Rebuilt the local API and transfer-worker after the retry-integrity change; unauthenticated transfer, plan, and SSE endpoints returned 401.
- Master Test remains **NOT READY**. Live cloud provider flows, multi-worker/crash tests, scheduled replication, Telegram adapters, desktop recursive folder upload, vault, and E2E/security validation remain pending.
- Implemented recursive desktop folder selection and drag/drop inspection with relative paths, symlink exclusion, a 31-level depth cap, and a 10,000-file selection cap. The desktop uploader now resolves nested destination folders before queuing files and shows selection/preparation errors in the upload dialog.
- Reused one path-validation/folder-resolution helper for web and desktop folder uploads. A focused path-safety test and native recursive-enumeration test passed; web and desktop frontend builds plus Rust `cargo check` passed with Rust 1.100.
- Remaining: cloud-backed folder upload in the packaged desktop app, S3 interrupted multipart tests, OneDrive discovery/live OAuth, Telegram adapters, scheduled replication, vault, multi-worker/crash/security/E2E acceptance. Master Test remains **NOT READY**.
- Added provider-size gates to upload routing and copy/replication creation. The configured app cap still applies; Google Drive's 5 TB and OneDrive's 250 GB provider limits are now enforced when an administrator raises that cap. Backend build and four focused provider/conflict tests passed.
- Hardened running-job cancellation: the API records a pending cancellation, the worker stops at its next lease check, finalizes the job as cancelled, and a replacement worker can recover an expired cancelling lease after a crash. State tests and backend build passed; a live cancellation race test remains pending.
- Added optional hourly, daily, and weekly UTC replication schedules using existing MySQL plan fields. The worker claims due plans with a row lock, creates the run and advances the schedule in one transaction; manual remains the default. The dashboard can change or resume schedules. Backend/frontend builds and UTC schedule tests passed. A local MySQL integration run verified two concurrent schedulers create one job and advance once; a disconnected account pauses the plan without an extra job. Crash timing and cloud-backed replication remain unverified.
- Added OneDrive file discovery through Microsoft Graph delta pages, encrypted cursor storage, folder/file mapping, file version tracking, and deletion reconciliation. The OAuth callback starts discovery, and the Files sync control can run it again. Applied the additive local MySQL migration. Backend/frontend builds, schema validation, URL-safety test, and a MySQL integration run with controlled Graph responses passed for initial import, update, and deletion. Live Microsoft OAuth/refresh/upload/download/cancellation remain unverified; the 25,000-item safety cap and cross-process sync serialization require further work.
- Fresh Master Test checkpoint: backend build and test suite passed (17 pass, 11 skipped, 0 fail); frontend tests passed (9 pass); web and desktop frontend builds passed; `git diff --check` passed. Vite emitted non-fatal ineffective dynamic import warnings. Telegram Bot/MTProto and encrypted vault remain unimplemented; provider-backed E2E, S3 failure scenarios, two-user authorization/isolation, worker fencing/crash recovery, live OAuth/transfers, packaged desktop flows, and production security/operations checks remain unverified. Master Test remains **NOT READY**.

## Session 2026-11-18 — Telegram, vault, and S3 recovery continuation
- Used the user-suggested Telegram-Drive repository as a design reference for Saved Messages defaults and bounded/retry-aware transfers. No source code was copied. MTProto is implemented with `teleproto`, server-owned Telegram API credentials, and encrypted account sessions.
- Added Telegram Bot API and MTProto storage providers and account connection UI. Bot tokens and MTProto sessions remain server-side encrypted; provider limits and unsupported operations are reflected in capability checks. Live Bot API/MTProto account and transfer flows remain unverified without disposable Telegram credentials.
- Added client-side libsodium secretstream encryption, Argon2id passphrase/recovery-key wrapping, ciphertext-only vault endpoints, opaque vault metadata replication, and the vault upload/unlock/recovery/download/local-preview UI. Crypto tests cover passphrase and recovery unlock, tamper/truncation rejection, and bounded stream framing. Browser/PWA and desktop acceptance remain unverified.
- Hardened S3 completion recovery with a persisted lease, exact-size reconciliation after process/request failure, expiry detection, client restart for expired sessions, and cancellation state claimed atomically before abort. A transient provider error while reconciling retains the lease until it can be retried rather than starting a duplicate completion.
- Backend `npm test`: 26 passed, 11 skipped, 0 failed. Skips are database-backed Drive sync and share-protection cases because their dedicated test database/fixture is not configured. Frontend tests: 12 passed. Web and desktop frontend builds and Prisma schema validation passed. Builds warn that the lazy vault chunk is 551.72 kB and report pre-existing ineffective dynamic imports for desktop modules.
- Applied migration `20261118110000_s3_completion_recovery` to local MySQL. Rebuilt backend, transfer worker, and frontend containers. Smoke checks: API `/health` 200; unauthenticated vault list/upload 401; frontend 200. Migration deploy reported all 27 migrations applied.
- Backend and frontend production-dependency audits reported 0 vulnerabilities; backend image install reported 0 vulnerabilities. `git diff --check` passed before the final documentation updates.
- Added durable provider retry scheduling for Telegram Bot API `retry_after` and MTProto flood-wait errors, bounded to one hour; focused unit tests pass. Added a MySQL worker-claim integration test; on a disposable `oneconnect_worker_claim_test` database, 12 concurrent workers each claimed a distinct job, and a lease-expired job was reclaimed with fencing token 2. The scratch database was dropped afterward.
- Fresh backend suite after these additions: 27 passed, 12 skipped (10 Drive-sync cases, share integration, and the worker integration unless its scratch URL is set), 0 failed. The worker integration passed separately against scratch MySQL. Frontend tests remain 12 passed.
- Source review found and fixed the batch-download provider dispatch: OneDrive, S3, and Telegram now use their adapter streams; Google retains its native-document export handling. Provider download capability is enforced for normal streams and batch downloads. Local Bot API mode is advertised as upload-only until safe shared-volume file reads are configured.
- Hardened the zero-knowledge vault raw-body ingress with an enforced streaming ciphertext-size ceiling (not just a post-upload byte comparison); oversized declared bodies are rejected before provider upload and streamed overflow is not forwarded to storage. Focused stream-limit test passes.
- Final local verification after the latest code changes: backend suite 29 passed, 12 skipped, 0 failed; frontend suite 12 passed; web and desktop builds passed; Prisma schema validation and `git diff --check` passed. Local MySQL migration status is up to date. Rebuilt API and transfer-worker; health 200, frontend 200, vault list/upload unauthenticated requests 401.
- Re-enabled the database-backed integration coverage on disposable scratch MySQL: all 10 Google Drive sync integration tests passed; worker claims/recovery passed; the live share-password API flow passed with two separate users and confirmed cross-user denial, protected-link behavior, revocation, and unlock rate limiting. Scratch schemas and the temporary API container were removed afterward. These use mocked Drive responses and local API behavior, not external provider credentials.
- Added syntax validation for Telegram Bot tokens and `redirect: 'error'` on token-bearing Bot API calls. The focused Bot API test passes.
- A managed repository security scan was started but did not produce a report in this session; the account's Daybreak access check returned `not_granted`. Manual source review plus dependency audits were performed, but this is not a completed full security assessment.
- Master Test remains **NOT READY**. Still open: real Google Drive/S3/OneDrive/Telegram account flows; actual S3 interruption/expired-parts/cancel scenarios against a test bucket; concurrent-worker claim and process-crash/fencing tests; two-user authorization/isolation tests; browser/PWA and packaged desktop E2E for uploads/transfers/vault recovery; and comprehensive security/operational validation. No benchmark or production-scale reliability claim was made.
