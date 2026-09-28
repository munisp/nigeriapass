# NigerianPass Onboarding PWA — TODO

## Core Pages
- [x] Landing page with portal cards and auth-aware header
- [x] Driver KYC onboarding (multi-step with liveness check)
- [x] Vehicle Registration form
- [x] Fleet KYB form
- [x] Device Management portal
- [x] Admin Review portal
- [x] Application Status page
- [x] Login/Register page (password + SMS OTP tabs)
- [x] Wallet page (TigerBeetle balance, Paystack top-up, transaction history)
- [x] Toll Plaza Map (Google Maps, plaza markers, detail panel)
- [x] USSD Simulator (*346# menu tree)
- [x] Admin Analytics dashboard (Recharts charts)
- [x] NFC Tag Provisioning page (Web NFC API + QR fallback)
- [x] Offline Dashboard (sync status, drafts, connectivity health)
- [x] Settings page (data saver, background sync, notifications, storage)

## PWA & Offline
- [x] Service worker (cache-first static, network-first navigation)
- [x] Web App Manifest with icons and shortcuts
- [x] PWA install banner (Android prompt + iOS instructions)
- [x] SW update notifier toast
- [x] Mobile bottom navigation bar
- [x] Offline fallback page (/offline.html)
- [x] Background Sync API (sync event + periodic sync)
- [x] IndexedDB offline infrastructure (drafts, retry queue, cache)
- [x] Form draft auto-save (DriverOnboarding)
- [x] Retry queue processor (auto-replay on reconnect)
- [x] Battery monitor (low/critical alerts)
- [x] Network status bar (offline/slow connection indicator)
- [x] Data Saver mode (auto-detect 2G + manual toggle)
- [x] Image compression utility (≤200 KB on data-saver)
- [x] Persistent storage request
- [x] Conflict resolution dialog (diff-style merge UI)
- [x] useConflictResolution hook

## Authentication
- [x] AuthContext (JWT + localStorage)
- [x] Protected route wrapper
- [x] SMS OTP login tab (6-digit box input, countdown timer)
- [x] Push notification opt-in (PushManager.subscribe)
- [x] useBackgroundSync hook

## Real-time
- [x] WebSocket notifications (useNotifications hook)
- [x] KYC status WebSocket push (useKycStatusPush hook)
- [x] Notification bell with unread badge
- [x] Live connection indicator

## Backend (tRPC)
- [x] Auth router (me, logout)
- [x] Sync router (processQueue, walletBalance, kycStatuses, ping, registerPeriodicSync)
- [x] System router (notifyOwner)

## Remaining / Future
- [x] Background Sync backend: wire processQueue to real DB mutations
- [x] TigerBeetle real integration (replaced with PostgreSQL wallet_accounts — wallet tRPC router)
- [x] Paystack webhook handler with HMAC-SHA512 verification
- [x] Africa's Talking SMS OTP backend (demo mode, AT_API_KEY secret configured)
- [x] Admin role enforcement on protected routes (adminProcedure guard)
- [x] Playwright E2E smoke test (Driver KYC journey)
- [x] Admin User Management page with role promotion UI
- [x] Paystack/Flutterwave/Interswitch payment gateway abstraction
- [x] Unified payments webhook router (HMAC verification, idempotency)
- [x] PaymentProviderSelector component (3 providers)
- [x] Extended Playwright E2E: admin portal, wallet, payment provider tests
- [x] Add PAYSTACK_SECRET_KEY, FLUTTERWAVE_SECRET_KEY, INTERSWITCH_MAC_KEY secrets
- [x] Wire Wallet top-up modal to POST /api/payments/initiate for live checkout
- [x] Build nightly reconciliation cron job for pending_match transactions
- [x] Admin router: runReconciliation, listUsers, setUserRole, getUserStats procedures
- [x] Africa's Talking SMS OTP backend (send + verify endpoints, DB-backed code storage)
- [x] express-rate-limit middleware on payment initiate, OTP send, and auth endpoints
- [x] Admin role promotion end-to-end verification
- [x] OTP flow Vitest integration test (17 tests: send, verify, JWT claims, error paths)
- [x] Admin Reconciliation page (/portal/reconciliation) with Run Now, history, live log
- [x] Reconciliation nav item in PortalLayout sidebar
- [x] Wallet tRPC router (getBalance, getTransactions procedures backed by PostgreSQL wallet_accounts)
- [x] Wire Wallet page to trpc.wallet.* instead of REST walletApi fallback
- [x] DB-backed reconciliation_runs table + server-side history persistence
- [x] Update AdminReconciliation page to load history from DB via trpc.admin.getReconciliationHistory
- [x] Landing page: add Reconciliation portal card and improve portal section
- [x] Persist scheduled reconciliation runs to DB (nightly scheduler writes to reconciliation_runs table)
- [x] /wallet/confirm page with Paystack/Flutterwave redirect handling and live balance polling
- [x] getReconciliationAlerts tRPC procedure + warning banner on AdminReconciliation page
- [x] Push notification to user when reconciliation credits their wallet
- [x] resolvedAt column on reconciliation_runs + resolveAlert tRPC mutation + AdminReconciliation banner update
- [x] Vitest test for wallet getBalance credit-detection polling logic
- [x] WebSocket wallet_credited toast on Wallet page client
- [x] Reconciliation run detail modal (full errors[], transaction refs)
- [x] Rate-limiter IPv6 fix (ipKeyGenerator helper for OTP send + payment initiate)
- [x] Comprehensive service/router/table/page audit
- [x] Unified project archive generation
- [x] trpc.admin.getAnalytics procedure with real PostgreSQL aggregations (KYC counts, wallet totals, reconciliation stats)
- [x] Wire AdminAnalytics page to trpc.admin.getAnalytics (replace hardcoded chart data)
- [x] trpc.kyc.submitFleetKYB backend + Fleet KYB form wiring
- [x] trpc.kyc.registerVehicle backend + Vehicle Registration form wiring
- [x] Flutter mobile api_service.dart: NigerianPassApiService class added (bridges to PWA tRPC backend)
- [x] Playwright E2E test for wallet top-up → /wallet/confirm → credit polling flow (12 tests)
- [x] trpc.kyc.getMyApplications + trpc.kyc.getApplicationStatus procedures
- [x] Admin approve/reject KYC mutations (approveApplication, rejectApplication, requestResubmission) with WebSocket push + SMS
- [x] Wallet tier upgrade notification (tier_upgraded WebSocket event + Wallet page toast)
- [x] Comprehensive platform audit v3 (all services, routers, tables, pages, env vars, TODOs, mocks, orphans)
- [x] Updated unified archive v3 (nigerianpass-unified-v3.zip, 1.1 MB, compared with v2 1.0 MB)
- [x] USSD gateway tRPC procedure (trpc.ussd.session backed by Africa's Talking USSD API)
- [x] Wire UssdSimulator.tsx to trpc.ussd.session (live backend toggle + demo/live mode switch)
- [x] NFC HSM tRPC procedure (trpc.nfc.provision with server-side HKDF key derivation)
- [x] Wire NfcProvisioning.tsx to trpc.nfc.provision (replace demo MASTER_SECRET)
- [x] Add payment env vars to server/_core/env.ts (PAYSTACK, FLUTTERWAVE, INTERSWITCH, AT_*); gateway.ts, otp.ts, sms.ts migrated to typed ENV
- [x] Comprehensive unified archive v4 (nigerianpass-v4-full.zip, 6.6MB, 3049 files: PWA+platform+apps+rust+merge+scripts)

- [x] USSD real handset test: shortcode config in env, session validator endpoint, Africa's Talking webhook signature verification, Vitest integration tests for USSD state machine
- [x] NFC batch provisioning: CSV upload endpoint, bulk HKDF key generation, DB storage for batch jobs, admin UI with progress tracking and CSV download of provisioned keys
- [x] Offline KYC draft sync: IndexedDB draft storage hook, auto-save on form change, resume-from-draft on page load, background sync queue integration, conflict resolution for server vs local draft
- [x] USSD test-harness endpoint: POST /api/ussd/test-handset for QA simulation
- [x] Offline sync wired to VehicleRegistration and FleetKYB (useKycDraftSync)
- [x] NFC batch job completion notification via notifyOwner
- [x] Device Management: replace MOCK_DEVICES with real tRPC device router + DB table
- [x] ApplicationStatus: replace MOCK_RECORDS fallback with real trpc.kyc.getApplicationStatus
- [x] Wallet CSV export: real CSV generation from transaction history
- [x] Wallet PDF receipt download: real PDF generation per transaction
- [x] AdminAnalytics CSV export: real export of analytics data
- [x] ApplicationStatus Resubmit button: wire to real resubmit flow
- [x] kyc.ts fleet/vehicle: remove demo mode, persist real data

## Audit Fixes (Phase 2-4)
- [x] Python API: Register orphan onboarding_api.py and wallet_api.py routers in main.py
- [x] Flutter router: Register transit, events, security, and liveness screens
- [x] DeviceManagement: Replace MOCK_DEVICES with real toll_devices DB table and tRPC CRUD router
- [x] ApplicationStatus: Remove mock data fallback, use real DB lookup only
- [x] ApplicationStatus: Wire Resubmit button to navigate to correct onboarding page
- [x] Wallet: Add real CSV export (trpc.wallet.exportTransactionsCsv)
- [x] Wallet: Add real PDF receipt download (trpc.wallet.getTransactionReceipt)
- [x] AdminAnalytics: Add real CSV export (trpc.admin.exportAnalyticsCsv)
- [x] kyc.ts: Remove demo mode fallbacks, throw TRPCError on DB unavailability
- [x] Landing.tsx: Replace Privacy Policy / Terms of Service coming-soon toasts with real pages
- [x] Login.tsx: Replace Privacy Policy / Terms of Service coming-soon toasts with real pages
- [x] Add PrivacyPolicy page (/privacy) with NDPA 2023 compliance
- [x] Add TermsOfService page (/terms) with Nigerian law compliance
- [x] VehicleRegistration: Wire useKycDraftSync for offline queue
- [x] FleetKYB: Wire useKycDraftSync for offline queue
- [x] NFC batch: Add notifyOwner on job completion
- [x] USSD: Add POST /api/ussd/test-handset test harness endpoint

## Next Steps (v7)
- [x] Transit API: Add GET /api/v1/transit/my-pass and GET /api/v1/transit/journeys customer endpoints
- [x] Events API: Add GET /api/v1/events/my-tickets and POST /api/v1/events/{id}/check-in customer endpoints
- [x] Flutter transit_screen: Wire to real transit API endpoints (my-pass, journeys, stations, tap-in, tap-out)
- [x] Flutter events_screen: Wire to real events API endpoints (my-tickets, check-in, list-events)
- [x] Device Management: Add devices.seed admin procedure with 12 NigerianPass plaza locations
- [x] Wallet PDF receipt: Upgrade to real formatted PDF with NigerianPass logo and HMAC stamp

## Next Steps (v8)
- [x] Flutter Transit QR scanner (mobile_scanner, tap-in/tap-out flow)
- [x] Device Management WebSocket heartbeat endpoint + useDeviceHeartbeat wiring
- [x] Wallet Paystack top-up (initiateTopup, verifyTopup webhook, UI)

## Next Steps (v9)
- [x] Flutterwave webhook: add Vitest tests for verif-hash verification and wallet credit flow (21 tests)
- [x] Device Management: add Simulate Heartbeat button in device detail panel (Radio icon, admin-only, calls trpc.devices.simulateHeartbeat)
- [x] Device Management: add Plaza QR code generation (trpc.devices.getPlazaQrCode) with signed HMAC URI, QR modal, SVG download, copy URI
- [x] Devices QR/heartbeat Vitest tests (12 tests: signed QR URI, HMAC sig, NOT_FOUND, FORBIDDEN, defaults)

## Next Steps (v10)
- [x] Bulk QR print sheet: admin "Print All Plaza QRs" button generates A4 PDF with QR codes for all NFC readers at a selected plaza (one per lane), using pdf-lib (trpc.devices.printPlazaQrSheet, 2-column A4 layout, signed HMAC URIs, auto-download)
- [x] Device alert resolution: trpc.devices.resolveAlert mutation + Resolve Alert button (ShieldCheck icon) in row actions and expanded detail panel, modal with resolution note textarea, clears alert count in DB
- [x] Real-time device map overlay: Toll Plaza Map page shows live device status dots on each plaza marker driven by trpc.devices.plazaSummary (15s polling) + useDeviceHeartbeat WS stream; sidebar cards show per-plaza device status mini-pills; detail panel shows live device grid
- [x] Vitest tests for resolveAlert (6 tests) and printPlazaQrSheet (5 tests) — 180 tests total, 12 test files, TypeScript 0 errors

## Next Steps (v11)
- [x] Alert audit log: device_alert_logs DB table (migrated), trpc.devices.getAlertHistory procedure, scrollable history modal in device detail (ShieldCheck history icon, resolvedByName, note, alertsCleared)
- [x] QR code expiry and rotation: qrExpiresAt in signed URI (24h TTL, configurable), trpc.devices.rotateQrCode mutation, Rotate QR button with countdown in device detail panel and QR modal
- [x] Plaza Health dashboard tile: sortable table in AdminAnalytics ranked by unhealthy device %, 30s polling, tri-color health bar, drill-down link to Device Management
- [x] Vitest tests for getAlertHistory (5 tests) and rotateQrCode (6 tests) — 191 tests total, 13 test files, TypeScript 0 errors

## Next Steps (v12)
- [x] Alert notification push: notifyOwner called in resolveAlert with device serial, plaza, alerts cleared, and resolution note
- [x] validateQrCode procedure: parses exp+sig from scanned URI, returns { valid, reason, device } for gate controller verification (6 tests)
- [x] Firmware update workflow: triggerFirmwareUpdate mutation, pendingFirmware flag on toll_devices, firmware_update_requested WS event, Update Firmware button wired in DeviceManagement (6 tests)
- [x] Vitest tests for validateQrCode (6) and triggerFirmwareUpdate (6) — 204 tests total, 14 test files, TypeScript 0 errors
- [x] Comprehensive platform audit: all services, routers, tables, pages, mobile screens, env vars, TODOs, mocks, orphans (see AUDIT_REPORT_V12.md)
- [x] Fix all audit findings: removed dead MOCK_RECORDS, added 4 missing PortalLayout nav links, wired Sign Out/Settings, added Batch Provision link to NfcProvisioning
- [x] Generated unified archive v9 (78 MB, 4,048 files — includes all 8 sub-projects, vs v8: 7.1 MB, 2,449 files)

## Next Steps (v13)
- [x] NFC master secret injection: QR_HMAC_SECRET() helper wired in all 4 QR procedures (getPlazaQrCode, printPlazaQrSheet, rotateQrCode, validateQrCode) — prefers ENV.nfcMasterSecret, falls back to JWT_SECRET, then demo string
- [x] Device firmware version tracking: trpc.devices.reportFirmwareVersion mutation (updates firmware field, isUpToDate flag, notifyOwner on successful update), Mark as Updated (teal) button in expanded device panel
- [x] USSD webhook signature enforcement: already fully implemented — verifyAtSignature middleware with crypto.timingSafeEqual, graceful bypass when secret not set, /api/ussd/health reports verification status
- [x] Vitest tests for reportFirmwareVersion (6 tests) — 210 tests total, 15 test files, TypeScript 0 errors

## Next Steps (v14)
- [x] Gate Controller QR Scanner page (/portal/validate-qr): live camera feed with jsQR decoding, calls trpc.devices.validateQrCode mutation, green/red result card with device name, plaza, lane, expiry countdown, scan history, nav link in PortalLayout
- [x] Firmware Broadcast Dashboard (/portal/firmware-broadcast): plaza selector, broadcastFirmwareUpdate batch mutation, per-device sent/skipped/failed progress table, nav link in PortalLayout Operations group
- [x] USSD session analytics: ussd_sessions DB table (migrated), trpc.ussd.getSessionStats procedure (totals, completion rate, avg interactions, avg duration, top menu paths, daily bar chart), Admin Analytics tile
- [x] Vitest tests for broadcastFirmwareUpdate (5 tests) and getSessionStats (3 tests) — 218 tests total, 16 test files, TypeScript 0 errors

## Next Steps (v15)
- [x] USSD session persistence: persistUssdSessionStart/End helpers in ussd.ts, wired into route handler — writes ussd_sessions row on session start, updates completedAt+menuPath on END response
- [x] QR scanner audit log: qr_scan_logs DB table (migrated), validateQrCode now persists each scan (serial, valid, reason, operator, plaza, lane), trpc.devices.getQrScanHistory procedure with acceptance rate summary
- [x] Firmware broadcast status polling: trpc.devices.getFirmwareBroadcastStatus procedure (total/upToDate/pending/byPlaza), live 3-card counter in Firmware Broadcast Dashboard with 30s auto-refresh and last-checked timestamp
- [x] Vitest tests for getQrScanHistory (4 tests) and getFirmwareBroadcastStatus (5 tests) — 227 tests total, 17 test files, TypeScript 0 errors

## Next Steps (v16)
- [x] QR Scan History admin page (/portal/qr-scan-logs): filterable table (date range, serial, valid/rejected), acceptance rate summary, powered by trpc.devices.getQrScanHistory
- [x] USSD session replay: trpc.ussd.getSessionDetail procedure (full menu path sequence for a session ID), row-expansion in USSD analytics tile
- [x] USSD session list page (/portal/ussd-sessions): admin list with filterable table, row-expansion to replay menu path, getSessionList procedure
- [x] Firmware version matrix: trpc.devices.getFirmwareMatrix procedure (version → device count → plaza list), stacked bar chart in Admin Analytics
- [x] Vitest tests for getSessionDetail, getSessionList, and getFirmwareMatrix (17 tests) — 244 tests total, 18 test files, TypeScript 0 errors
