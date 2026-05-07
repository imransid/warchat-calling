# WarmChats Calling Module

Click-to-call · Inbound forwarding · Number masking · Missed-call SMS · Usage metering

> **Provider:** Telnyx (only) — Voice API + Messaging API + Number Order API
> **Backend:** NestJS 10 + TypeScript, CQRS pattern
> **Database:** PostgreSQL via Prisma
> **Queue:** BullMQ on Redis (webhook retries)

---

## Table of contents

1. [What this module does](#what-this-module-does)
2. [Architecture at a glance](#architecture-at-a-glance)
3. [How a call works](#how-a-call-works)
   - [Outbound (click-to-call)](#outbound-click-to-call)
   - [Inbound (forwarded to agent)](#inbound-forwarded-to-agent)
   - [Missed-call SMS](#missed-call-sms)
   - [Number masking](#number-masking)
   - [Usage metering](#usage-metering)
4. [Quick start](#quick-start)
5. [API reference](#api-reference)
   - [Authentication](#authentication)
   - [Agent endpoints](#agent-endpoints)
   - [Admin endpoints](#admin-endpoints)
   - [Webhook endpoints (Telnyx)](#webhook-endpoints-telnyx)
   - [Health](#health)
6. [Frontend integration](#frontend-integration)
7. [Data model](#data-model)
8. [Configuration](#configuration)
9. [Operations](#operations)
10. [Out of scope](#out-of-scope)

---

## What this module does

Each agent gets one dedicated business phone number. That same number handles inbound calls, outbound calls, and SMS:

- **Outbound:** Agent clicks "Call" on a lead. The system rings the agent's real phone, then bridges the customer in once the agent picks up. The customer's caller ID shows the **business number**, never the agent's personal phone.
- **Inbound:** Customer dials the business number. The system forwards to the agent's real phone with a 25-second ring timeout. If the agent doesn't pick up, the system auto-sends a configurable SMS to the customer.
- **Logging:** Every call (answered, missed, failed) is recorded in the lead's conversation thread with full metadata.
- **Metering:** Minutes are counted per billing cycle. When the workspace exceeds its plan, overage is auto-charged at the configured per-minute rate (the workspace can also be configured to block instead).

> **Not in scope:** in-app VoIP. The agent always uses their real phone.

---

## Architecture at a glance

```
┌──────────────┐   1. POST /api/calling/calls/outbound
│   Frontend   │ ──────────────────────────────────────►┐
└──────────────┘                                         │
                                                         ▼
┌──────────────────────────────────────────────────────────────────┐
│                        WarmChats Backend                          │
│                                                                   │
│   CallingController       AdminController     WebhookController   │
│         │                       │                    ▲            │
│         ▼                       ▼                    │            │
│   ┌──────────────────────────────────────┐    Telnyx events       │
│   │  CQRS  (Commands + Queries + Events)  │   (call.answered,     │
│   └──────────────────────────────────────┘    call.hangup, ...)   │
│         │                                            │            │
│         ▼                                            │            │
│   ┌─────────────────┐    ┌──────────────────┐       │            │
│   │   Prisma / PG   │    │  BullMQ / Redis  │       │            │
│   │   (call_logs,   │    │  (webhook retry  │       │            │
│   │    usage_records│    │   queue)         │       │            │
│   │    webhook_logs)│    └──────────────────┘       │            │
│   └─────────────────┘                                │            │
│                                                      │            │
└──────────────────────────────────────────────────────┼────────────┘
                                                       │
                  2. Telnyx Voice API                  │
                  (initiate call, transfer, hangup)    │
                                                       ▼
                                          ┌──────────────────────┐
                                          │       TELNYX         │
                                          │  (PSTN gateway)      │
                                          └──────────────────────┘
                                            │              │
                                       agent's phone   customer's phone
```

The system is **event-driven through Telnyx webhooks**, not by polling. The frontend kicks off a call with one HTTP request and then watches the call thread for new entries — every state change comes from Telnyx hitting our `/webhooks/calling/telnyx/status` endpoint.

---

## How a call works

### Outbound (click-to-call)

This is the SOW #3 flow. Seven steps, three of them are Telnyx-driven.

```
STEP 1  ─  Agent opens lead profile and clicks "Call"
            │
            ▼
            POST /api/calling/calls/outbound  { leadId }

STEP 2  ─  Backend safeguard checks
            • agent has assigned business number?
            • workspace plan has calling enabled?
            • within usage limit (or autoChargeOverage = true)?
            • lead exists?
            │
            ▼
            CallingController → CanUserMakeCallQuery → InitiateOutboundCallCommand

STEP 3  ─  Telnyx Voice API: dial the AGENT first
            POST https://api.telnyx.com/v2/calls
                from = business number  (caller ID)
                to   = agent's real phone
            Returns call_control_id; we store it as Call.providerCallSid.
            We also stash customerNumber + stage:DIALING_AGENT in
            Call.providerMetadata for the bridge step.
            │
            ▼

STEP 4  ─  Agent's phone rings. Agent picks up.
            Telnyx fires:  call.answered  (direction = outgoing)
            ────────────────────────────────────────────────
            Webhook controller looks up the call by providerCallSid,
            reads customerNumber from providerMetadata, then issues:
            POST /v2/calls/{call_control_id}/actions/transfer
                from = business number  (number masking)
                to   = customer's phone
            stage flips to BRIDGING_CUSTOMER (so duplicate webhooks
            don't double-transfer).
            │
            ▼

STEP 5  ─  Customer's phone rings, showing the BUSINESS NUMBER.
            (The agent's real phone is never exposed.)
            │
            ▼

STEP 6  ─  Customer picks up.  Telnyx bridges both legs.
            call.bridged → Call.status = IN_PROGRESS, answeredAt = now

STEP 7  ─  Either party hangs up.
            call.hangup → CompleteCallHandler:
              • Call.status = COMPLETED, duration set, completedAt set
              • UsageRecord row created (minutes = duration / 60)
              • If overage and autoChargeOverage = true, cost computed
                at BillingCycle.overageRate
              • CallEvent.CALL_COMPLETED logged
```

If the agent never answers, Telnyx fires `call.hangup` with `hangup_cause=originator_cancel` instead. The customer is never dialed — there's nothing to miss. The Call goes to `NO_ANSWER`.

If the customer never answers after the bridge, Telnyx fires `call.hangup` with `hangup_cause=customer_busy` or similar. The Call closes as `NO_ANSWER` / `BUSY` / `FAILED` — but **no missed-call SMS fires** because outbound SMS-on-no-answer wasn't asked for in the SOW (only inbound).

---

### Inbound (forwarded to agent)

```
STEP 1  ─  Customer dials the business number.

STEP 2  ─  Telnyx hits POST /webhooks/calling/telnyx/status
            event_type = call.initiated, direction = incoming
            │
            ▼

STEP 3  ─  Webhook controller answers the inbound leg, then transfers
            to the assigned agent's real phone with the configured
            ringTimeout (default 25s, configurable 20–30s):

            POST /v2/calls/{ccid}/actions/answer
            POST /v2/calls/{ccid}/actions/transfer
                from         = business number  (preserves caller ID)
                to           = agent's real phone
                timeout_secs = 25
            │
            ▼

STEP 4a ─  Agent picks up.
            call.answered → call.bridged → Call.status = IN_PROGRESS

STEP 4b ─  Agent doesn't pick up within 25s, OR busy, OR failed.
            call.hangup with appropriate hangup_cause
            │
            ▼
            CompleteCallHandler detects direction=INBOUND and
            status ∈ {NO_ANSWER, BUSY, FAILED}, dispatches
            SendMissedCallSmsCommand.

STEP 5  ─  Either way, the call entry shows up in the lead's
            inbox/conversation thread with full metadata.
```

The "find the agent" step works because each `PhoneNumber` row has a unique `assignedToUserId`. If no agent is assigned to the dialled number, the inbound call errors out (and the customer hears Telnyx's default treatment).

---

### Missed-call SMS

Only fires for **inbound** missed calls. The flow:

1. `CompleteCallHandler` sees `direction === INBOUND` and `status ∈ {NO_ANSWER, BUSY, FAILED}`.
2. Loads `CallingConfiguration.missedCallSmsTemplate` for the workspace. Default text:
   > Currently in an appointment. I will call you back shortly or text me please.
3. Dispatches `SendMissedCallSmsCommand`, which calls Telnyx Messaging API:
   ```
   POST https://api.telnyx.com/v2/messages
     from = business number
     to   = customer's number
     text = template
     messaging_profile_id = TELNYX_MESSAGING_PROFILE_ID
   ```
4. Records a `MISSED_CALL_SMS_SENT` CallEvent regardless of success — failure stores the error in `payload.error` rather than throwing, because SMS failure mustn't cascade into call-completion failure.

---

### Number masking

Three places enforce that the customer always sees the business number, never the agent's:

1. **Outbound dial agent** — `from = businessNumber` on the Telnyx Calls API request. The agent sees the business number when their phone rings.
2. **Outbound bridge customer** — `from = businessNumber` on the `transfer` action. The customer sees the business number.
3. **Inbound forward to agent** — `from = businessNumber` (the dialled number) on the `transfer` action. The agent sees the business number, not the customer's caller ID, so the lead's identity is preserved through the masked leg.

The agent's real phone (`User.phoneNumber`) is _only_ used as a `to` field on Telnyx, never as a `from`. It is never exposed to a customer.

---

### Usage metering

Per workspace, per billing cycle:

- `BillingCycle.planMinuteLimit` — minutes included in the plan (configured via admin API).
- `BillingCycle.overageRate` — dollars per minute over the limit.
- `CallingConfiguration.autoChargeOverage` — if `true`, calls past the limit go through and are billed at overage. If `false`, calls past the limit are blocked at the safeguard layer.
- One `UsageRecord` row per completed call: `minutes = duration / 60`, `cost` is non-zero only when this call's portion crossed the plan boundary.

The active billing cycle is monthly. If no active cycle exists, the system creates one on first use covering the current calendar month.

---

## Quick start

```bash
# 1. Install
yarn install

# 2. Set up .env (see Configuration section)
cp .env.example .env
# edit DATABASE_URL, TELNYX_API_KEY, TELNYX_CONNECTION_ID,
# TELNYX_MESSAGING_PROFILE_ID, REDIS_HOST, JWT_SECRET, APP_URL

# 3. Migrate the DB
npx prisma generate
npx prisma migrate deploy

# 4. Run
yarn start:dev

# 5. Browse the live API docs
open http://localhost:3000/api/docs
```

Configure the Telnyx webhook URL in Mission Control → Voice → Connections:

```
https://your-app.com/webhooks/calling/telnyx/status
```

(Telnyx will send all call events here. Both inbound and outbound. Both initial events and final hangup events.)

---

## API reference

All paths shown without the global prefix — every API path is served under `/api`. Webhooks are NOT under `/api`.

### Authentication

Every `/api/...` request requires:

```
Authorization: Bearer <JWT>
```

The JWT payload must include `sub` (user ID). The auth strategy resolves the user and attaches `{ id, email, name, workspaceId }` as `req.user`.

Webhook routes (`/webhooks/calling/telnyx/*`) do **not** use JWT — they use Telnyx's Ed25519 signature verification (`Telnyx-Signature-ed25519` and `Telnyx-Timestamp` headers).

---

### Agent endpoints

#### `GET /api/calling/can-call`

Pre-flight safeguard check. Call this on lead-profile load to decide whether to enable the Call button.

**Response 200:**

```json
{
  "canCall": true,
  "reasons": []
}
```

When the user can't call:

```json
{
  "canCall": false,
  "reasons": [
    "User does not have an assigned business number",
    "Calling is not enabled for this workspace"
  ]
}
```

**Important:** when `autoChargeOverage = true`, exceeding the plan limit does **not** add a reason here. Auto-charge is the SOW-mandated default.

---

#### `POST /api/calling/calls/outbound`

Initiate an outbound click-to-call.

**Body:**

```json
{
  "leadId": "123e4567-e89b-12d3-a456-426614174000",
  "metadata": { "campaign": "Q3-followup" }
}
```

**Response 200:**

```json
{
  "callId": "8c3f2e94-...-...",
  "status": "INITIATED"
}
```

**Errors:**

- `400` — lead not found, agent has no phone, or other safeguard failure
- `403` — calling disabled or no business number

The call goes through the agent-first → bridge-customer flow. The frontend should poll or re-fetch `GET /api/calling/leads/:leadId/calls` to see status updates.

**Curl:**

```bash
curl -X POST http://localhost:3000/api/calling/calls/outbound \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"leadId":"123e4567-e89b-12d3-a456-426614174000"}'
```

---

#### `GET /api/calling/calls/:callId`

Full details of a single call, including the event timeline.

**Response 200:**

```json
{
  "id": "8c3f2e94-...",
  "providerCallSid": "v3:abc123...",
  "direction": "OUTBOUND",
  "status": "COMPLETED",
  "fromNumber": "+14155559999",
  "toNumber": "+14155555678",
  "duration": 185,
  "initiatedAt": "2026-05-07T10:30:00.000Z",
  "answeredAt": "2026-05-07T10:30:08.000Z",
  "completedAt": "2026-05-07T10:33:13.000Z",
  "lead":   { "id": "...", "name": "Jane Smith", "phoneNumber": "+14155555678" },
  "agent":  { "id": "...", "name": "John Doe",  "email": "john@warmchats.com" },
  "businessNumber": { "id": "...", "phoneNumber": "+14155559999" },
  "callEvents": [
    { "eventType": "CALL_INITIATED",  "timestamp": "...", "payload": {...} },
    { "eventType": "AGENT_RINGING",   "timestamp": "...", "payload": {...} },
    { "eventType": "CUSTOMER_RINGING","timestamp": "...", "payload": {...} },
    { "eventType": "CALL_CONNECTED",  "timestamp": "...", "payload": {...} },
    { "eventType": "CALL_COMPLETED",  "timestamp": "...", "payload": {...} }
  ]
}
```

---

#### `GET /api/calling/leads/:leadId/calls?limit=50&offset=0`

Lead's call history — for rendering inside the conversation thread.

**Response 200:**

```json
{
  "calls": [
    {
      "id": "8c3f2e94-...",
      "direction": "OUTBOUND",
      "status": "COMPLETED",
      "duration": 185,
      "initiatedAt": "2026-05-07T10:30:00Z",
      "completedAt": "2026-05-07T10:33:13Z",
      "agent": { "id": "...", "name": "John Doe", "email": "..." }
    }
  ],
  "total": 25,
  "limit": 50,
  "offset": 0
}
```

`limit` is capped at 100. Sort is `createdAt DESC`.

---

#### `GET /api/calling/usage/workspace?billingCycleId=...`

Current cycle's usage stats. `billingCycleId` is optional — defaults to the active cycle.

**Response 200:**

```json
{
  "billingCycle": {
    "id": "cycle-123",
    "startDate": "2026-05-01T00:00:00Z",
    "endDate": "2026-05-31T23:59:59Z",
    "planLimit": 1000
  },
  "usage": {
    "totalMinutes": 487.5,
    "totalCost": 0.0,
    "totalCalls": 142,
    "percentageUsed": 48.75,
    "remainingMinutes": 512.5,
    "isOverLimit": false
  },
  "breakdown": {
    "byStatus": {
      "COMPLETED": 120,
      "NO_ANSWER": 15,
      "BUSY": 5,
      "FAILED": 2
    }
  }
}
```

---

#### `GET /api/calling/analytics/dashboard?startDate=...&endDate=...`

Workspace-wide stats for a date range.

**Response 200:**

```json
{
  "totalCalls": 342,
  "byDirection": { "INBOUND": 87, "OUTBOUND": 255 },
  "byStatus": [
    { "status": "COMPLETED", "count": 280, "avgDuration": 165.4 },
    { "status": "NO_ANSWER", "count": 42, "avgDuration": 0 },
    { "status": "BUSY", "count": 15, "avgDuration": 0 }
  ],
  "avgDuration": 165.4,
  "answerRate": 81.87,
  "topAgents": [
    { "agentId": "user-1", "callCount": 87 },
    { "agentId": "user-2", "callCount": 64 }
  ]
}
```

---

### Admin endpoints

All under `/api/admin/calling`. The caller's workspace comes from `req.user.workspaceId` — these are scoped per tenant automatically.

#### `POST /api/admin/calling/phone-numbers`

Buy a new business number from Telnyx and add it to the workspace.

**Body:**

```json
{ "areaCode": "415", "country": "US" }
```

**Response 201:**

```json
{
  "phoneNumberId": "abc-123-def",
  "message": "Phone number provisioned successfully"
}
```

The Telnyx `/v2/available_phone_numbers` search runs first; if no candidate exists in that area code, returns `400`.

---

#### `GET /api/admin/calling/phone-numbers?includeReleased=false`

List all numbers in the workspace.

**Response 200:**

```json
[
  {
    "id": "abc-123",
    "phoneNumber": "+14155559999",
    "provider": "telnyx",
    "providerSid": "...",
    "status": "ACTIVE",
    "capabilities": { "voice": true, "sms": true },
    "assignedToUser": { "id": "user-1", "name": "John Doe", "email": "..." },
    "createdAt": "2026-05-01T00:00:00Z"
  }
]
```

---

#### `PUT /api/admin/calling/phone-numbers/:phoneNumberId/assign`

Assign a number to an agent. Each agent can have at most one assigned number (`User.assignedNumber` is `@unique`).

**Body:**

```json
{ "userId": "user-456", "phoneNumberId": "abc-123" }
```

**Response 200:**

```json
{
  "phoneNumberId": "abc-123",
  "userId": "user-456",
  "message": "Phone number assigned successfully"
}
```

**Errors:** `409` if the user already has a different number assigned.

---

#### `DELETE /api/admin/calling/phone-numbers/:id?reason=...`

Release a number back to Telnyx. **Irreversible** — Telnyx may not let you re-purchase the same number.

---

#### `GET /api/admin/calling/configuration`

Current calling settings for the workspace.

**Response 200:**

```json
{
  "id": "cfg-1",
  "workspaceId": "ws-1",
  "provider": "telnyx",
  "ringTimeout": 25,
  "missedCallSmsTemplate": "Currently in an appointment...",
  "callingEnabled": true,
  "recordingEnabled": false,
  "autoChargeOverage": true
}
```

If the workspace has never had a config row, this endpoint creates one with defaults.

---

#### `PUT /api/admin/calling/configuration`

Update settings. Partial — only fields included are updated.

**Body (all fields optional):**

```json
{
  "ringTimeout": 28,
  "missedCallSmsTemplate": "We're sorry we missed you. We'll call back soon.",
  "callingEnabled": true,
  "recordingEnabled": false,
  "autoChargeOverage": true,
  "provider": "telnyx"
}
```

**Validation:** `ringTimeout` must be in `[20, 30]` (SOW mandate). `provider` must be `"telnyx"`.

---

#### `PUT /api/admin/calling/usage/limits`

Update the active billing cycle's plan limit and overage rate.

**Body:**

```json
{ "planMinuteLimit": 2000, "overageRate": 0.018 }
```

**Response 200:**

```json
{
  "message": "Usage limits updated successfully",
  "billingCycleId": "cycle-123",
  "planMinuteLimit": 2000,
  "overageRate": 0.018
}
```

**Errors:** `404` if no active billing cycle exists.

---

#### `GET /api/admin/calling/usage/breakdown?billingCycleId=...&groupBy=agent`

Detailed usage report. `groupBy` is one of `agent`, `day`, `status`.

**`groupBy=agent` response:**

```json
{
  "billingCycleId": "cycle-123",
  "groupBy": "agent",
  "breakdown": [
    {
      "agentId": "user-1",
      "agentName": "John Doe",
      "agentEmail": "john@warmchats.com",
      "totalMinutes": 187.5,
      "totalCost": 1.65,
      "totalCalls": 45,
      "answeredCalls": 38,
      "missedCalls": 7
    }
  ]
}
```

The `agent` view joins `usage_records` with `calls` so missed calls (which never produce usage rows) still count toward `missedCalls`.

**`groupBy=day` response:** array of `{ date, totalCalls, totalMinutes, avgDuration, answeredCalls }`.

**`groupBy=status` response:** array of `{ status, totalCalls, avgDuration, totalDurationSeconds }`.

---

#### `GET /api/admin/calling/webhooks/logs?status=FAILED&limit=50&offset=0`

Webhook reliability dashboard. Scoped to the caller's workspace.

**Response 200:**

```json
{
  "total": 12,
  "limit": 50,
  "offset": 0,
  "logs": [
    {
      "id": "log-1",
      "providerEventId": "evt-abc",
      "provider": "telnyx",
      "eventType": "call.hangup",
      "status": "FAILED",
      "retryCount": 2,
      "lastRetryAt": "2026-05-07T10:35:00Z",
      "errorMessage": "Call not found",
      "callId": "...",
      "workspaceId": "...",
      "receivedAt": "2026-05-07T10:30:00Z"
    }
  ]
}
```

`status` filter accepts `RECEIVED`, `PROCESSING`, `PROCESSED`, `FAILED`, `RETRYING`.

---

#### `POST /api/admin/calling/webhooks/:webhookLogId/retry`

Manually retry a failed webhook. The row is flipped to `RETRYING` and `lastRetryAt` is reset to epoch so the BullMQ sweep picks it up on the next minute tick.

**Response 200:**

```json
{
  "webhookLogId": "log-1",
  "message": "Webhook retry scheduled — will run on the next sweep tick"
}
```

---

### Webhook endpoints (Telnyx)

You don't _call_ these — Telnyx does. You configure them in Telnyx Mission Control.

| Path                                    | What configures it                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `POST /webhooks/calling/telnyx/status`  | Mission Control → Voice → your Voice API connection → "Webhook URL"                                 |
| `POST /webhooks/calling/telnyx/inbound` | (Optional) Voice profile → "Inbound webhook URL" — only if your account uses a separate inbound URL |
| `POST /webhooks/calling/telnyx/sms`     | Messaging Profile → "Inbound webhook URL"                                                           |

The status webhook receives **every** call event (inbound and outbound, every state change). The controller routes events:

- `call.initiated` + `direction=incoming` → answer + transfer to agent
- `call.answered` + `direction=outgoing` → bridge customer (the SOW #3 fix)
- `call.hangup` → `CompleteCallHandler` (logs, usage, missed-call SMS)
- All events → idempotent `WebhookLog` row keyed by `providerEventId`

**Idempotency:** Telnyx may deliver the same event twice. The `WebhookLog.providerEventId @unique` constraint plus an upsert at the start of `ProcessWebhookHandler` ensures each event is processed exactly once.

**Retries:** if a webhook handler throws, the `WebhookLog` row is marked `FAILED`. `WebhookRetryScheduler` (cron, every minute) picks up failed rows with `retryCount < 3` and re-dispatches them through `WebhookRetryProcessor`. Backoff: 1, 5, 30 minutes.

---

### Health

#### `GET /health`

Liveness probe. No auth, no `/api` prefix. Use this for load-balancer health checks.

**Response 200:**

```json
{
  "status": "ok",
  "timestamp": "2026-05-07T10:00:00Z",
  "uptime": 12345.67,
  "environment": "production",
  "version": "1.0.0"
}
```

---

## Frontend integration

The smallest possible integration — six calls cover the entire agent UX:

```ts
// On lead profile mount
const { canCall, reasons } = await fetch("/api/calling/can-call", {
  headers: auth,
}).then((r) => r.json());
const { calls } = await fetch(`/api/calling/leads/${leadId}/calls`, {
  headers: auth,
}).then((r) => r.json());

// User clicks Call button
async function placeCall() {
  if (!canCall) return showReasons(reasons);
  const { callId } = await fetch("/api/calling/calls/outbound", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ leadId }),
  }).then((r) => r.json());
  // Their phone is ringing now. Poll the call thread.
  pollCallThread(leadId, callId);
}

// Polling pattern (or use websockets if you have them)
async function pollCallThread(leadId, activeCallId) {
  const interval = setInterval(async () => {
    const { calls } = await fetch(`/api/calling/leads/${leadId}/calls`, {
      headers: auth,
    }).then((r) => r.json());
    const active = calls.find((c) => c.id === activeCallId);
    updateCallEntryInThread(active);
    if (
      ["COMPLETED", "NO_ANSWER", "BUSY", "FAILED", "CANCELED"].includes(
        active.status,
      )
    ) {
      clearInterval(interval);
    }
  }, 3000);
}
```

For **inbound** calls, the agent's phone just rings — there's no frontend signal. The agent answers their phone normally. The call shows up in the thread on the next refresh (or push).

---

## Data model

```
Workspace
  └── PhoneNumber  (one per agent — assignedToUserId @unique)
  └── User  (agent)
        └── phoneNumber  ← agent's REAL personal phone
        └── assignedNumber  ← the business number above
  └── Lead
  └── Call
        ├── direction       (INBOUND | OUTBOUND)
        ├── status          (INITIATED | RINGING | IN_PROGRESS | COMPLETED |
        │                    NO_ANSWER | BUSY | FAILED | CANCELED)
        ├── duration        (seconds)
        ├── fromNumber, toNumber, customerNumber, agentPhoneNumber
        ├── businessNumber  → PhoneNumber
        ├── lead            → Lead
        ├── agent           → User
        ├── providerCallSid (Telnyx call_control_id, @unique)
        ├── providerMetadata (JSON: stage, customerNumber for bridge)
        └── callEvents      → CallEvent[]
              └── eventType (CALL_INITIATED, AGENT_RINGING,
                             CUSTOMER_RINGING, CALL_CONNECTED,
                             CALL_COMPLETED, CALL_NO_ANSWER, ...,
                             MISSED_CALL_SMS_SENT)
  └── BillingCycle
        ├── planMinuteLimit, overageRate
        └── usageRecords    → UsageRecord[]
              ├── minutes, cost, isOverage
              ├── call    → Call
              └── agent   → User
  └── CallingConfiguration  (one per workspace, @unique)
        ├── ringTimeout (20–30s)
        ├── missedCallSmsTemplate
        ├── callingEnabled, recordingEnabled, autoChargeOverage
        └── provider (always "telnyx")

WebhookLog  (workspace-scoped after match)
  ├── providerEventId @unique  ← idempotency key
  ├── provider, eventType, status, retryCount
  └── payload (full Telnyx body)
```

---

## Configuration

### Environment variables

```bash
# --- Database ---
DATABASE_URL=postgresql://user:pass@host:5432/warmchats

# --- Redis (for BullMQ retry queue) ---
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=...

# --- Telnyx ---
TELNYX_API_KEY=KEY...                   # Mission Control → API Keys
TELNYX_CONNECTION_ID=...                # Voice API connection ID
TELNYX_MESSAGING_PROFILE_ID=...         # for missed-call SMS
TELNYX_PUBLIC_KEY=...                   # base64, for webhook signature verification

# --- Auth ---
JWT_SECRET=...

# --- App ---
APP_URL=https://api.warmchats.com       # used as the base of webhook callback URLs
NODE_ENV=production
PORT=3000
CORS_ORIGIN=https://app.warmchats.com
```

### Workspace-level settings (admin UI)

Configurable per workspace via `PUT /api/admin/calling/configuration`:

| Field                   | Type        | SOW range / default       | What it controls                                                      |
| ----------------------- | ----------- | ------------------------- | --------------------------------------------------------------------- |
| `ringTimeout`           | int seconds | 20–30, default 25         | How long inbound calls ring the agent before fallback                 |
| `missedCallSmsTemplate` | string      | client default            | Body of the auto-SMS sent on missed inbound                           |
| `callingEnabled`        | boolean     | default true              | Master kill switch — workspace-wide                                   |
| `recordingEnabled`      | boolean     | default false             | (Stub — no recording behaviour wired)                                 |
| `autoChargeOverage`     | boolean     | default true (client req) | If true, calls go through past plan limit and overage is auto-charged |
| `provider`              | enum        | only `"telnyx"`           | Telephony provider                                                    |

---

## Operations

### Webhook reliability

Three layers of defence ensure webhook events are never lost:

1. **Idempotency.** Every webhook is upserted into `WebhookLog` keyed by `providerEventId @unique`. Duplicate deliveries from Telnyx are no-ops.
2. **Synchronous retry-on-error.** If `ProcessWebhookHandler` throws, the row goes to `RETRYING` (or `FAILED` after 3 attempts).
3. **Asynchronous sweep.** `WebhookRetryScheduler` (cron, every minute) picks up `FAILED` / `RETRYING` rows with `retryCount < 3`. Backoff: 1, 5, 30 minutes. Each retry re-dispatches `ProcessWebhookCommand` against the persisted payload.

We always 200 back to Telnyx — even on app-level errors — so Telnyx doesn't add its own retries on top of ours.

### What to watch in production

- `WebhookLog` rows where `status = FAILED` and `retryCount >= 3` — these are the ones the system gave up on. Monitor count, not zero is a problem.
- `Call.status = FAILED` rate — should be < 1% of attempts.
- `usage_records` per cycle vs. `BillingCycle.planMinuteLimit` — overage spikes.
- Telnyx 4xx rates from `TelnyxProvider` logs — usually means bad credentials, missing connection_id, or numbers without messaging profiles.

### Common issues

| Symptom                                                         | Likely cause                                                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Customer dialled but agent never rings                          | No `PhoneNumber` row for that number, OR `assignedToUserId` is null                                   |
| Outbound call rings agent, then silence                         | Missing `customerNumber` in `Call.providerMetadata` — check `InitiateOutboundCallHandler` ran cleanly |
| Missed-call SMS doesn't send                                    | `TELNYX_MESSAGING_PROFILE_ID` not set, OR business number not attached to that profile in Telnyx      |
| Calls past limit get blocked despite `autoChargeOverage = true` | Workspace config not loading — check `CallingConfiguration.autoChargeOverage` value in DB             |
| Number purchase returns 400                                     | No available numbers in that area code on Telnyx; try a different one                                 |

---

## Out of scope

Per the SOW (and confirmed in client Discord April 28):

- **In-app VoIP.** No softphone, no WebRTC. The agent always uses their real phone.
- **Voicemail recording / transcription.** Not in this module.
- **Call recording.** `recordingEnabled` is a flag in the schema for forward-compat; no recording behaviour is wired up.
- **IVR / phone menus.** Inbound calls forward straight to the assigned agent — no menu, no queue.
- **Multi-agent ringing / round-robin.** One number = one agent.
- **SMS conversations.** Inbound SMS is acknowledged with HTTP 200 but routing is delegated to the messaging module (separate scope).
- **Outbound missed-call SMS.** Missed-SMS only fires on missed _inbound_, not on outbound where the customer didn't answer.

Anything in this list can be added as a Change Request with a separate quote.
