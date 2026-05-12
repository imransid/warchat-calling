# WarmChats Calling — Integration Plan (v2: web + phone hybrid)

## Context

The `warchat-calling` NestJS backend currently implements the **phone-only** flow from the original SOW: Telnyx SIP/PSTN click-to-call where calls happen on the agent's real cell phone (number-masked outbound, ring-timeout inbound forward, missed-call SMS). The frontend `Warcmchats-APP` (React 18 + Vite + Tailwind + shadcn/ui, Axios, React Query) has zero calling code.

**Client clarification:** the feature must support **both** in-browser calls *and* the existing phone forwarding, with parallel-ring semantics:

- **Inbound:** Lead dials the business number → call **simultaneously** rings inside the WarmChats web app **and** the agent's cell phone. Whichever answers first wins; the other leg drops. If neither answers, the existing missed-call SMS still fires.
- **Outbound:** Agent clicks "Call" in the inbox → default origin is the browser (WebRTC); the existing "ring my phone first then bridge" flow remains available as a secondary option ("Call from my phone instead").

This requires three additions the current backend doesn't have:

1. **WebRTC layer** — browsers need to register as SIP endpoints. Using **Telnyx's `@telnyx/webrtc` JS SDK** (matches the existing provider; cheapest to ship) backed by per-agent **Telnyx Credentials/SIP Users** issued by the calling backend.
2. **Real-time signaling** — backend → browser push for "incoming call", "call accepted on other device", "call ended", call-state changes. The current backend is REST + webhook only. Add a NestJS Socket.IO gateway.
3. **Parallel-ring orchestration** — on inbound, use Telnyx Call Control to spawn two outbound legs in parallel (one to the SIP user = web, one to the agent's cell) and bridge whichever picks up first (`call.answered` on either leg → transfer/bridge customer leg, hang up the other).

## Decisions (confirmed)

1. **Hosting:** Calling backend on its own subdomain (e.g. `calling.warmchats.com`). Frontend uses new `VITE_CALLING_API_BASE` and `VITE_CALLING_WS_URL` env vars.
2. **Lead mapping:** Sync-on-first-call (upsert `Lead` by `(workspaceId, phoneNumber)`).
3. **Auth:** Share `JWT_SECRET_KEY` with the Flask main API at `/Users/sarwaralam/Desktop/Projects/Jumatechs/Warcmchats-APP`. JWTs are HS256, issued by `flask-jwt-extended` ([app/service/auth_session_service.py](../Warcmchats-APP/app/service/auth_session_service.py) lines 121-132) with claims `sub` (user UUID), `org_id` (workspace UUID), `role`, `session_id`, `type:"access"`. Email/name are NOT in the JWT — calling backend lazily upserts `User` + `Workspace` from JWT claims on first request.
4. **Scope:** Full agent web-call UI + phone fallback + admin UI (SOW #9).
5. **WebRTC provider:** Telnyx `@telnyx/webrtc` SDK (frontend) + Telnyx Credentials (backend). Sticking with one vendor.
6. **Inbound ring policy:** parallel-ring (web + phone simultaneously). Configurable per workspace via existing `CallingConfiguration` (add `ringStrategy: 'parallel' | 'web_first' | 'phone_first'`, default `parallel`).
7. **Outbound default:** web. The existing agent-first PSTN flow remains as a "Call from my phone instead" option in the Call button menu.

---

## Backend changes (`warchat-calling`)

### B1. JWT auth (real, no test middleware in prod)

- Files: gate the test-auth middleware in [src/main.ts](src/main.ts) on `NODE_ENV !== 'production'`; new `src/modules/auth/{auth.module.ts,jwt.strategy.ts,jwt-auth.guard.ts,roles.guard.ts,roles.decorator.ts,user-sync.service.ts}`.
- `passport-jwt` strategy: `secretOrKey = process.env.JWT_SECRET_KEY`, `algorithms: ['HS256']`, header bearer extractor. Validate `payload.type === 'access'`.
- `validate(payload)` returns `{ id: payload.sub, workspaceId: payload.org_id, role: payload.role, sessionId: payload.session_id }`. Calls `UserSyncService.ensure(payload.sub, payload.org_id)` to upsert `Workspace` and `User` rows lazily.
- Apply `@UseGuards(JwtAuthGuard)` on [calling.controller.ts](src/modules/calling/controllers/calling.controller.ts) and [admin.controller.ts](src/modules/calling/controllers/admin.controller.ts). Add `@Roles('Owner','Manager')` for admin routes (RolesGuard reads `req.user.role`).
- Webhook controller stays unauthenticated (Telnyx signature verification covers it).
- Rename env var in [.env.example](.env.example): `JWT_SECRET` → `JWT_SECRET_KEY` so it matches the Flask app exactly.

### B2. Lead upsert on outbound initiate

- Extend `InitiateCallDto` in [src/modules/calling/dto/index.ts](src/modules/calling/dto/index.ts): make `leadId` optional, add `phoneNumber` (E.164 validated) and optional `name`. Add `origin: 'web' | 'phone'` (default `'web'`).
- In [initiate-outbound-call.handler.ts](src/modules/calling/commands/handlers/initiate-outbound-call.handler.ts): if `leadId` not provided, upsert `Lead` by `(workspaceId, phoneNumber)`. Then branch on `origin`:
  - `'web'` → the actual call is dialed by the browser via WebRTC SDK (see B7); this handler just creates the `Call` row in `INITIATED` state with `providerCallSid` set later from the webhook. Returns the `callId` only.
  - `'phone'` → existing agent-first PSTN flow unchanged.

### B3. CORS, webhook signature, Telnyx config

- [src/main.ts](src/main.ts): `CORS_ORIGIN=https://app.warmchats.com,http://localhost:5173`.
- [webhook.controller.ts](src/modules/calling/controllers/webhook.controller.ts): Ed25519 signature verification using `TELNYX_PUBLIC_KEY`, reject >5min skew.
- Add Telnyx provider methods in [src/modules/calling/infrastructure/telephony/telnyx.provider.ts](src/modules/calling/infrastructure/telephony/telnyx.provider.ts):
  - `createCredential(agentId)` / `deleteCredential(credentialId)` — Telnyx SIP user under a single shared Credential Connection
  - `createOnDemandJwt(credentialId)` — short-lived (≤60s) login JWT for `@telnyx/webrtc` (Telnyx endpoint: `POST /v2/telephony_credentials/{id}/token`)
  - `forkInboundCall(callControlId, sipUri, phoneNumber, fromNumber, ringTimeout)` — issues two parallel `transfer`/`dial` actions on the inbound call control session; cancels loser on `call.answered`.

### B4. New module: WebRTC

- New folder `src/modules/calling/webrtc/`:
  - `webrtc.controller.ts` — `POST /api/calling/webrtc/token` (JWT-guarded). Looks up agent's `User.telnyxCredentialId`; if missing, creates one via the provider and stores it; returns `{ login_token, sip_uri, expires_at }`.
  - `webrtc.service.ts` — orchestrates credential lifecycle (create on first use, rotate on revocation).
- Prisma changes (new migration):
  - `User { telnyxCredentialId String? @unique, telnyxSipUri String? }`
  - `CallingConfiguration { ringStrategy String @default("parallel") }` (values: `parallel`, `web_first`, `phone_first`)
  - `Call { webLegSid String?, phoneLegSid String?, answeredVia String? }` — to track which leg won
- Settings UI uses this to let the agent see "Web ready ✓" status.

### B5. New module: Socket.IO gateway for real-time signaling

- New folder `src/modules/calling/gateway/`:
  - `calling.gateway.ts` — NestJS WebSocket gateway, namespace `/calls`, transport `websocket`.
  - JWT handshake auth: client sends token in `auth.token`; on connection, validate via the same JWT strategy and join the user's room (`user:{userId}`) and workspace room (`workspace:{workspaceId}`).
  - **Server → client events:**
    - `incoming_call` `{ callId, leadName?, fromNumber, businessNumber, callControlId }` — emit when inbound `call.initiated` is processed and the agent is identified.
    - `call_state` `{ callId, status, answeredVia? }` — emit on every Telnyx webhook transition so the active-call UI updates without polling.
    - `call_taken_elsewhere` `{ callId }` — emit to other web sessions of the same user when one device answers, so all other rings stop.
  - **Client → server events:**
    - `accept_call` `{ callId }` — frontend has just clicked Accept in the WebRTC SDK; server forks/cancels the phone leg.
    - `reject_call` `{ callId }` — server cancels both legs.
    - `hangup_call` `{ callId }` — server hangs up the active leg.
- Webhook handlers ([process-webhook.handler.ts](src/modules/calling/commands/handlers/process-webhook.handler.ts), [complete-call.handler.ts](src/modules/calling/commands/handlers/complete-call.handler.ts), [handle-inbound-call.handler.ts](src/modules/calling/commands/handlers/handle-inbound-call.handler.ts)) emit these events via `CallingGateway.emitToUser(userId, event, data)` after each state change.

### B6a. Call waiting / busy-on-busy (MVP)

When an inbound call arrives and the assigned agent already has an `IN_PROGRESS` or `RINGING` call:

1. In [handle-inbound-call.handler.ts](src/modules/calling/commands/handlers/handle-inbound-call.handler.ts), before the parallel-ring step, query: `SELECT 1 FROM Call WHERE agentId=? AND status IN ('RINGING','IN_PROGRESS') LIMIT 1`.
2. If a row exists:
   - Skip the fork. Mark the new Call row `status='NO_ANSWER'`, append `CallEvent { eventType: 'BUSY_AGENT_OCCUPIED' }` (new enum value).
   - Trigger the existing `SendMissedCallSmsCommand` (same template).
   - Emit Socket.IO `missed_while_busy { callId, fromNumber, leadName? }` to the agent's user room.
3. Frontend's `ActiveCallWindow` shows a non-blocking toast: "📞 Missed call from … while you were on this call".

Phase 2 (`callWaitingEnabled` flag, default `false`, **out of scope for v1**): hold-and-swap UI using Telnyx hold/transfer actions and parallel `TelnyxRTC.Call` instances. Not implemented now.

### B6b. Inbound parallel-ring orchestration

- Refactor `routeInboundTelnyxCall()` in [webhook.controller.ts](src/modules/calling/controllers/webhook.controller.ts) / [handle-inbound-call.handler.ts](src/modules/calling/commands/handlers/handle-inbound-call.handler.ts):
  1. On `call.initiated` (direction=incoming): look up `agent = PhoneNumber.assignedToUser` for the business number. Create `Call` row.
  2. Answer the inbound leg (Telnyx Call Control `answer`).
  3. Read `CallingConfiguration.ringStrategy`:
     - `parallel`: fire **two `transfer` actions in parallel** — one to `sip:{agent.telnyxSipUri}` (web), one to `{agent.phoneNumber}` (cell). Both with `timeout_secs = ringTimeout`. Telnyx Call Control allows this via separate outbound legs bridged to the inbound call's call_control_id; store both `call_control_id`s in `Call.providerMetadata.webLegSid` and `phoneLegSid`.
     - `web_first` / `phone_first`: ring one leg with timeout, on no-answer trigger the other.
  4. Emit `incoming_call` Socket.IO event to the agent's user room.
  5. On first `call.answered` for either leg → mark `answeredVia` (`'web'` or `'phone'`), issue Telnyx `hangup` on the losing leg, then proceed with the existing bridge.
  6. If both legs `call.hangup` without answer → existing missed-call SMS path unchanged.

### B7. Outbound from web

- Web SDK initiates the call directly with Telnyx; the call is identified server-side by a Telnyx webhook `call.initiated` with `direction=outgoing` from the agent's SIP credential.
- On that webhook, the backend looks up the `Call` row created by `POST /api/calling/calls/outbound { origin: 'web' }` (matched by `client_state` — we set `client_state = base64(callId)` in the SDK invite). Fills in `providerCallSid`, sets `agentPhoneNumber = sip:<credentialId>`, `fromNumber = business number` (Telnyx enforces this via the credential's caller-ID-presentation setting).
- Rest of the lifecycle (call.answered → IN_PROGRESS, call.hangup → COMPLETED + UsageRecord) is unchanged.

### B8. Admin endpoints (already mostly there; add missing)

- Existing: `GET/PUT /api/admin/calling/configuration`, phone-number CRUD, usage limits, webhook logs.
- Add `ringStrategy` to `UpdateCallingConfigDto` validation (`enum`).
- Add `GET /api/admin/calling/agents/web-status` — list of agents with `{ userId, hasCredential, lastSeenOnline }` (lastSeenOnline driven by Socket.IO connection presence).

### B9. Background, infra

- `docker-compose.yml`: no new services needed (Telnyx is the SFU; no mediasoup, no TURN server of our own — Telnyx provides STUN/TURN).
- New env vars in [.env.example](.env.example):
  - `JWT_SECRET_KEY` (renamed)
  - `TELNYX_PUBLIC_KEY` (webhook signature)
  - `TELNYX_CREDENTIAL_CONNECTION_ID` (the SIP Credential Connection that owns all agent SIP users)
  - `TELNYX_SIP_DOMAIN` (e.g. `warmchats.sip.telnyx.com`)

---

## Frontend changes (`Warcmchats-APP`)

All paths below are relative to `/Users/sarwaralam/Desktop/Projects/Jumatechs/warmchat-frontend/Warcmchats-APP`.

### F1. Env, dependencies, API client

- Add to [.env](../warmchat-frontend/Warcmchats-APP/.env):
  ```
  VITE_CALLING_API_BASE=https://calling.warmchats.com
  VITE_CALLING_WS_URL=wss://calling.warmchats.com/calls
  ```
- Install: `@telnyx/webrtc`, `socket.io-client`.
- New file `src/api/calling.ts`: second axios instance bound to `VITE_CALLING_API_BASE`, sharing the same auth interceptor pattern as [helpers/api.tsx](../warmchat-frontend/Warcmchats-APP/helpers/api.tsx) lines 10-28. Reuse `useFetch`/`useApiMutation` from [helpers/hooks.tsx](../warmchat-frontend/Warcmchats-APP/helpers/hooks.tsx).
- New file `src/types/calling.ts`: `CallSummary`, `CallDetails`, `CallStatus`, `CallDirection`, `PhoneNumber`, `CallingConfiguration` (with `ringStrategy`), `WorkspaceUsage`, `CanCallResponse`, `WebRtcToken`.
- API surface: existing endpoints + `getWebRtcToken()`, `initiateOutbound({ phoneNumber, name?, origin: 'web'|'phone' })`, `acceptIncoming(callId)`, `rejectIncoming(callId)`, `hangupCall(callId)`.

### F2. Hooks and providers

New files in `src/hooks/` and `src/context/`:

- `src/context/CallingContext.tsx` — single source of truth for client-side call state. Mounted near root in [src/main.tsx](../warmchat-frontend/Warcmchats-APP/src/main.tsx). Holds: `{ telnyxClient, socket, incomingCall, activeCall, microphoneState, ringStrategy, startOutbound(args), acceptIncoming(), rejectIncoming(), hangup(), toggleMute(), sendDtmf(d) }`.
- `src/hooks/useTelnyxClient.ts` — on mount: fetch `/webrtc/token`, instantiate `TelnyxRTC` SDK, subscribe to SDK events (`telnyx.notification` for incoming-invite, `telnyx.ready`, `telnyx.error`). Handle token refresh (refetch before expiry).
- `src/hooks/useCallingSocket.ts` — connect to `VITE_CALLING_WS_URL` with `auth: { token: localStorage.token }`, expose typed `on()`/`emit()`. Reconnect with backoff.
- `src/hooks/useCanCall.ts`, `useActiveCall.ts` (still needed for fallback/polling on errors), `useLeadCalls.ts` — as before.
- `src/hooks/useRingtone.ts` — play/stop a ringtone audio asset while `incomingCall` is set. Asset: `public/sounds/ringtone.mp3` (add a royalty-free clip).

### F3. Agent UI components

New folder `src/components/calling/`:

- `CallButton.tsx` — Split button with primary "Call" action (origin=web) + dropdown caret offering "Call from my phone instead" (origin=phone). Disabled if `!canCall`; tooltip shows reasons. On click: calls `startOutbound({ phoneNumber, name, origin })`.
- `IncomingCallModal.tsx` — Driven by `useCallingContext().incomingCall`. Shows lead name (if known), from number, business number ringing on. Buttons: Accept (large green, triggers SDK auto-answer + emits `accept_call`), Decline (red, emits `reject_call`). Plays ringtone. Auto-dismisses if backend emits `call_taken_elsewhere`. Stays above all routes.
- `ActiveCallWindow.tsx` — Floating, draggable mini-window pinned bottom-right. Renders `<audio>` element bound to the SDK's remote stream. Controls: Mute, DTMF keypad, Transfer-to-phone (server endpoint that moves the bridge from web → cell — optional, P2), Hangup. Shows call duration ticker, status badge (Ringing / On call / Reconnecting). Survives route changes via `CallingContext` + `MainLayout` mounting.
- `CallHistoryList.tsx` — merged with messages by timestamp; shows direction arrow, status, duration, "Answered on web" / "Answered on phone" badge.
- `UsageChip.tsx` — `{totalMinutes}/{planLimit} min` chip; red badge when over.
- `WebReadinessBadge.tsx` — small dot in the inbox header showing "Web call ready" (green: SDK registered) vs "Phone only" (gray: SDK not connected → fall back to phone flow only). Tooltip explains.

### F4. Wire into existing inbox and layout

- [src/components/Inbox.tsx](../warmchat-frontend/Warcmchats-APP/src/components/Inbox.tsx) — right-panel contact header: `<CallButton phoneNumber={contact.phone} name={contact.name} />` next to the name. Below the message thread, render `<CallHistoryList>` interleaved with messages by timestamp.
- [src/components/ThreadView.tsx](../warmchat-frontend/Warcmchats-APP/src/components/ThreadView.tsx) and `ThreadViewSMS.tsx` — `<CallButton />` in the thread header toolbar.
- [src/components/MainLayout.tsx](../warmchat-frontend/Warcmchats-APP/src/components/MainLayout.tsx) — mount `<IncomingCallModal />` and `<ActiveCallWindow />` at root so they persist across routes and are always available regardless of which screen the agent is on when a call comes in.
- [src/components/Sidebar.tsx](../warmchat-frontend/Warcmchats-APP/src/components/Sidebar.tsx) — `<UsageChip />` + `<WebReadinessBadge />`.
- [src/main.tsx](../warmchat-frontend/Warcmchats-APP/src/main.tsx) — wrap the app in `<CallingProvider>` (inside existing `<CRMProvider>`). Provider auto-initializes only after auth (token present), so the public login/marketing pages are unaffected.

### F5. Admin pages (Owner/Manager only via existing `RoleProtectedRoute`)

Routes added in [src/App.tsx](../warmchat-frontend/Warcmchats-APP/src/App.tsx):

| Route | Component | Purpose |
|---|---|---|
| `/settings/calling/numbers` | `CallingPhoneNumbersPage` | Provision (POST), list, assign-to-agent, release |
| `/settings/calling/configuration` | `CallingConfigurationPage` | Ring timeout (20–30s), missed-call SMS template, **ring strategy radio** (parallel / web first / phone first), autoChargeOverage, enabled toggle |
| `/settings/calling/usage` | `CallingUsagePage` | Workspace usage chart + per-agent breakdown + edit plan limits + overage rate |
| `/settings/calling/agents` | `CallingAgentsPage` | Per-agent web-status list (online/offline, credential ok), force-reset credential |
| `/settings/calling/webhooks` | `CallingWebhookLogsPage` | Failed webhook list with manual retry |

---

## Files to create

**Backend:**
- `src/modules/auth/{auth.module.ts, jwt.strategy.ts, jwt-auth.guard.ts, roles.guard.ts, roles.decorator.ts, user-sync.service.ts}`
- `src/modules/calling/webrtc/{webrtc.module.ts, webrtc.controller.ts, webrtc.service.ts}`
- `src/modules/calling/gateway/{calling.gateway.ts, ws-jwt.guard.ts}`
- Prisma migration adding `User.telnyxCredentialId`, `User.telnyxSipUri`, `CallingConfiguration.ringStrategy`, `Call.webLegSid`, `Call.phoneLegSid`, `Call.answeredVia`
- `scripts/seed-dev-workspace.ts`

**Frontend:**
- `src/api/calling.ts`, `src/types/calling.ts`
- `src/context/CallingContext.tsx`
- `src/hooks/{useTelnyxClient.ts, useCallingSocket.ts, useCanCall.ts, useActiveCall.ts, useLeadCalls.ts, useRingtone.ts}`
- `src/components/calling/{CallButton.tsx, IncomingCallModal.tsx, ActiveCallWindow.tsx, CallHistoryList.tsx, UsageChip.tsx, WebReadinessBadge.tsx}`
- `src/components/calling/admin/{CallingPhoneNumbersPage.tsx, CallingConfigurationPage.tsx, CallingUsagePage.tsx, CallingAgentsPage.tsx, CallingWebhookLogsPage.tsx}`
- `public/sounds/ringtone.mp3` (royalty-free asset)

## Files to modify

**Backend:**
- [src/main.ts](src/main.ts) — gate test-auth on non-prod; wire Socket.IO adapter
- [src/modules/calling/calling.module.ts](src/modules/calling/calling.module.ts) — register webrtc + gateway modules
- [src/modules/calling/controllers/calling.controller.ts](src/modules/calling/controllers/calling.controller.ts), [admin.controller.ts](src/modules/calling/controllers/admin.controller.ts) — `@UseGuards(JwtAuthGuard)`, `@Roles(...)`
- [src/modules/calling/dto/index.ts](src/modules/calling/dto/index.ts) — `InitiateCallDto` extensions, `UpdateCallingConfigDto` adds `ringStrategy`
- [src/modules/calling/commands/handlers/initiate-outbound-call.handler.ts](src/modules/calling/commands/handlers/initiate-outbound-call.handler.ts) — lead upsert + origin branching
- [src/modules/calling/commands/handlers/handle-inbound-call.handler.ts](src/modules/calling/commands/handlers/handle-inbound-call.handler.ts), [process-webhook.handler.ts](src/modules/calling/commands/handlers/process-webhook.handler.ts), [complete-call.handler.ts](src/modules/calling/commands/handlers/complete-call.handler.ts) — emit Socket.IO events, parallel-ring orchestration, winner/loser leg handling
- [src/modules/calling/controllers/webhook.controller.ts](src/modules/calling/controllers/webhook.controller.ts) — Telnyx signature verification
- [src/modules/calling/infrastructure/telephony/telnyx.provider.ts](src/modules/calling/infrastructure/telephony/telnyx.provider.ts) — credential + on-demand JWT methods, fork-call helper
- `.env.example` — rename + add new vars

**Frontend:**
- [.env](../warmchat-frontend/Warcmchats-APP/.env) — add `VITE_CALLING_API_BASE`, `VITE_CALLING_WS_URL`
- [src/main.tsx](../warmchat-frontend/Warcmchats-APP/src/main.tsx) — wrap with `<CallingProvider>`
- [src/App.tsx](../warmchat-frontend/Warcmchats-APP/src/App.tsx) — 5 admin routes
- [src/components/Inbox.tsx](../warmchat-frontend/Warcmchats-APP/src/components/Inbox.tsx), [ThreadView.tsx](../warmchat-frontend/Warcmchats-APP/src/components/ThreadView.tsx), `ThreadViewSMS.tsx` — call buttons + history merge
- [src/components/MainLayout.tsx](../warmchat-frontend/Warcmchats-APP/src/components/MainLayout.tsx) — mount IncomingCallModal + ActiveCallWindow
- [src/components/Sidebar.tsx](../warmchat-frontend/Warcmchats-APP/src/components/Sidebar.tsx) — UsageChip + WebReadinessBadge
- `package.json` — add `@telnyx/webrtc`, `socket.io-client`

## Reuse (don't duplicate)

- Axios interceptor pattern from [helpers/api.tsx](../warmchat-frontend/Warcmchats-APP/helpers/api.tsx) — clone the instance, share the interceptor logic.
- React Query hooks from [helpers/hooks.tsx](../warmchat-frontend/Warcmchats-APP/helpers/hooks.tsx) for non-realtime endpoints.
- `RoleProtectedRoute` from [src/components/RoleProtectedRoute.jsx](../warmchat-frontend/Warcmchats-APP/src/components/RoleProtectedRoute.jsx).
- Existing toast pattern via `react-hot-toast` (already in package.json) for call errors.

## Out of scope

- Mediasoup / self-hosted SFU (Telnyx is the SFU).
- Group calls (SOW is 1-on-1).
- Call recording UI (backend has `recordingUrl` field but doesn't populate yet — separate ticket).
- Push notifications for mobile devices (out of project scope — web + cell-phone parallel ring covers the SOW).
- Switching mid-call between web and phone (P2; nice-to-have).
- Twilio provider — stays as backend abstraction for future swap, but not exercised in this work.

---

## Verification

End-to-end smoke test:

1. **Backend boots with real JWT + Socket.IO:**
   ```bash
   cd warchat-calling
   docker-compose up -d postgres redis
   npx prisma migrate deploy
   npm run start:dev
   ```
   - `GET /health` → 200.
   - `GET /api/calling/can-call` without token → 401.
   - With a real access token from the Flask API (signed with shared `JWT_SECRET_KEY`) → 200 + `{ canCall: false, reasons: ["No business number assigned"] }`. `User`+`Workspace` rows lazily created.
   - Socket.IO handshake to `/calls` with same token → connected; without token → rejected.

2. **WebRTC credential issued:** `GET /api/calling/webrtc/token` → `{ login_token, sip_uri }`. Confirm `User.telnyxCredentialId` populated.

3. **Admin: provision + assign a Telnyx test number** via `/settings/calling/numbers`. `can-call` flips to `true`.

4. **Configuration:** `/settings/calling/configuration` — set ring strategy = parallel, ring timeout 25s.

5. **Outbound from web:**
   - In Inbox, click Call on a contact with a phone number.
   - Browser registers, places call via `@telnyx/webrtc`; backend's `POST /calls/outbound { origin: 'web' }` creates the Call row.
   - Customer's phone rings (caller-ID = business number). Pick up. `ActiveCallWindow` flips to "On call". Talk. Hang up from the window. Status flips to COMPLETED, duration recorded, usage incremented, call appears in history.

6. **Outbound from phone fallback:**
   - Click the dropdown on the Call button → "Call from my phone instead".
   - Agent's cell rings first (existing flow). Pick up → customer is bridged. Hangup → logged same way.

7. **Inbound parallel ring:**
   - From a separate phone, dial the business number.
   - **Simultaneously**: web `IncomingCallModal` pops with ringtone + cell phone rings.
   - **Case A:** Click Accept in browser → cell stops ringing within ~1s; call audio in browser; `Call.answeredVia = 'web'`.
   - **Case B:** Pick up on cell → browser modal dismisses (driven by `call_taken_elsewhere`); audio on cell; `answeredVia = 'phone'`.
   - **Case C:** Reject in browser → cell continues ringing; cell unanswered for 25s → both legs drop, missed-call SMS fires, call logged `NO_ANSWER`.
   - **Case D:** Ignore everywhere → 25s timeout, both legs drop, missed-call SMS, `NO_ANSWER`.

8. **Multi-tab safety:** Open two browser tabs as same agent → inbound rings in both; accept in one → other auto-dismisses.

9. **Usage metering:** Place a 2-min call → `/settings/calling/usage` reflects +2 min. Drop plan to 1 min + `autoChargeOverage=false` → `can-call` returns false; call button disabled.

10. **Webhook reliability:** Stop Postgres briefly during a webhook delivery, restart → failed entry appears in `/settings/calling/webhooks`; click Retry → flips to PROCESSED.

11. **Auth boundary:** Log in as `Representative` → `/settings/calling/*` 403s. Log out → all `/api/calling/*` calls 401, Socket.IO disconnects.

12. **Build:** `npm run build` clean in both repos.
