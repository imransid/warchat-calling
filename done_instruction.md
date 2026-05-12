# WarmChats Calling — Implementation Summary

Implementation of the SOW calling feature with dual-channel support (in-browser WebRTC **and** phone forwarding). Both 1-on-1 outbound click-to-call and inbound parallel-ring (web + cell at the same time) are wired end-to-end.

---

## Backend (`warchat-calling`)

### New modules
- **`src/modules/auth/`** — real JWT auth: `jwt.strategy.ts` (HS256, shared `JWT_SECRET_KEY` with Flask main API), `jwt-auth.guard.ts`, `roles.guard.ts`, `roles.decorator.ts`, `user-sync.service.ts` (lazy upsert User+Workspace from JWT claims), `auth.module.ts`
- **`src/modules/calling/webrtc/`** — `WebRtcController` + `WebRtcService` issuing per-agent Telnyx SIP credentials and short-lived login JWTs
- **`src/modules/calling/gateway/`** — `CallingGateway` (Socket.IO `/calls` namespace, JWT handshake, per-user rooms)

### Modified
- `src/main.ts` — Socket.IO adapter, rawBody for signature verification, test-auth now opt-in via `USE_TEST_AUTH=true`
- `src/app.module.ts` — `AuthModule` registered globally
- `src/modules/calling/controllers/calling.controller.ts` — `@UseGuards(JwtAuthGuard)`, new `GET /api/calling/calls/by-phone/:phoneNumber`, updated DTO handling for `origin`+`phoneNumber`
- `src/modules/calling/controllers/admin.controller.ts` — `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles('Owner','Manager')`, new `GET /api/admin/calling/agents/web-status`, `ringStrategy` save support
- `src/modules/calling/controllers/webhook.controller.ts` — Telnyx Ed25519 signature verification, parallel-ring orchestration (fork web + cell), fork-winner bridging + loser hangup, SIP-origin web-outbound row creation
- `src/modules/calling/commands/handlers/handle-inbound-call.handler.ts` — busy-on-busy detection → NO_ANSWER + missed-SMS, `incoming_call`/`missed_while_busy` socket emits, returns `InboundCallPlan` (web SIP URI, phone, ring strategy, timeout)
- `src/modules/calling/commands/handlers/initiate-outbound-call.handler.ts` — branches on `origin: 'web' | 'phone'`, upserts Lead by phone
- `src/modules/calling/commands/handlers/complete-call.handler.ts` — terminal `call_state` socket emit
- `src/modules/calling/infrastructure/telephony/telnyx.provider.ts` — `createCredential`, `deleteCredential`, `createOnDemandJwt`, `dialForkLeg`, `bridge`, `hangup`
- `src/modules/calling/dto/index.ts` — extended `InitiateCallDto` (phoneNumber/name/origin), `UpdateCallingConfigDto.ringStrategy`
- `prisma/schema.prisma` — `User.telnyxCredentialId`, `User.telnyxSipUri`, nullable `User.email/name`, `Call.{webLegSid,phoneLegSid,answeredVia,origin}`, `CallingConfiguration.ringStrategy`, new `CallEventType` values including `BUSY_AGENT_OCCUPIED`
- `.env.example` — renamed `JWT_SECRET` → `JWT_SECRET_KEY`, added `TELNYX_PUBLIC_KEY`, `TELNYX_CREDENTIAL_CONNECTION_ID`, `TELNYX_SIP_DOMAIN`
- `package.json` — added `@nestjs/passport`, `@nestjs/jwt`, `passport`, `passport-jwt`, `@nestjs/websockets`, `@nestjs/platform-socket.io`, `socket.io`

**Backend `yarn build` → exit 0, clean.**

## Frontend (`Warcmchats-APP`)

### New
- `src/types/calling.ts` — full TS types
- `src/api/calling.ts` — axios instance bound to `VITE_CALLING_API_BASE` with same auth-interceptor pattern as `helpers/api.tsx`; `callingApi` + `callingAdminApi` surfaces
- `src/context/CallingContext.tsx` — `<CallingProvider>` orchestrating Telnyx WebRTC SDK + Socket.IO + incoming/active call state + ringtone (Web Audio fallback)
- `src/hooks/{useCanCall.ts, useLeadCalls.ts}`
- `src/components/calling/{CallButton.tsx, IncomingCallModal.tsx, ActiveCallWindow.tsx, MissedWhileBusyToast.tsx, CallHistoryList.tsx, UsageChip.tsx}`
- `src/components/calling/admin/{CallingPhoneNumbersPage, CallingConfigurationPage, CallingUsagePage, CallingAgentsPage, CallingWebhookLogsPage}.tsx`

### Modified
- `src/main.tsx` — wrapped with `<CallingProvider>`
- `src/components/MainLayout.tsx` — mounts `<IncomingCallModal>`, `<ActiveCallWindow>`, `<MissedWhileBusyToast>` so calls work from any route
- `src/components/Inbox.tsx` — replaced the placeholder `tel:` link with `<CallButton>`, added `<CallHistoryList>` panel
- `src/App.tsx` — five admin routes under `/settings/calling/*` (Owner/Manager only via existing `RoleProtectedRoute`)
- `.env` — `VITE_CALLING_API_BASE`, `VITE_CALLING_WS_URL`
- `package.json` — `@telnyx/webrtc`, `socket.io-client`

**Frontend TS check on calling code → 0 new errors** (58 pre-existing in unrelated files like `Inbox.tsx`'s `InboxAppointmentRecord` and `helpers/api.tsx`'s old axios types). The `vite build` blocker is an unrelated missing `@progress/kendo-react-common` peer dep in `OnboardingForAgentsManager.tsx`.

## How calls actually flow

- **Outbound (web)** → `<CallButton>` calls `POST /api/calling/calls/outbound { origin: 'web', phoneNumber }` (creates placeholder row), then `TelnyxRTC.newCall(...)` from the browser. Telnyx fires `call.initiated` (direction=outgoing, from=SIP credential), webhook controller matches by SIP URI → creates real `Call` row → backend emits `call_state RINGING` on Socket.IO.
- **Outbound (phone)** → dropdown "Call from my phone instead" → existing agent-first PSTN flow (unchanged).
- **Inbound (parallel ring)** → Telnyx `call.initiated` → `HandleInboundCallCommand` runs busy check, picks `ringStrategy`, answers anchor, dials web SIP + cell PSTN in parallel via `dialForkLeg`. First leg's `call.answered` runs `resolveForkWinner` → atomic `answeredVia` claim → bridge winner to anchor + hangup loser + emit `call_taken_elsewhere` to other tabs. SDK invite ringing the browser is caught in `CallingContext` and pops `<IncomingCallModal>`.
- **Busy-on-busy** → agent already on a call → new inbound Call row created as `NO_ANSWER` + `BUSY_AGENT_OCCUPIED` event, missed-call SMS fires, `missed_while_busy` socket event pops the `<MissedWhileBusyToast>`.

## Before you run it

1. **Backend `.env`**: set `JWT_SECRET_KEY` to the same value as the Flask app's `JWT_SECRET_KEY`, plus `TELNYX_*` credentials including a new **Credential Connection** for SIP users and the `TELNYX_PUBLIC_KEY` for webhook verification.
2. **Migrate**: `npx prisma migrate dev --name calling_web_layer` to apply the schema changes.
3. **CORS**: set `CORS_ORIGIN=https://app.warmchats.com,http://localhost:5173`.
4. **Frontend `.env`**: `VITE_CALLING_API_BASE` + `VITE_CALLING_WS_URL` (already added with placeholder `calling.warmchats.com`).
5. **Pre-existing build blocker**: `OnboardingForAgentsManager.tsx` imports `@progress/kendo-react-popup` which needs `@progress/kendo-react-common` as a peer dep that the project doesn't have. Either `yarn add @progress/kendo-react-common` or replace that one usage — independent of this work.
