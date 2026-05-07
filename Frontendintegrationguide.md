# Frontend Integration Guide — WarmChats Calling Module

> **Audience:** Frontend developer wiring up the calling UX (React/Next.js assumed, but every example is plain `fetch` + TypeScript and translates trivially to Vue, Svelte, plain JS).
>
> **You should be able to read this top-to-bottom and ship the whole feature without asking the backend team anything.**

---

## Table of contents

1. [What you're building](#what-youre-building)
2. [Setup](#setup)
3. [TypeScript types — copy these](#typescript-types--copy-these)
4. [API client — copy this](#api-client--copy-this)
5. [The call state machine](#the-call-state-machine)
6. [Recipe 1 — Lead profile: Call button + history](#recipe-1--lead-profile-call-button--history)
7. [Recipe 2 — Placing an outbound call](#recipe-2--placing-an-outbound-call)
8. [Recipe 3 — Polling the active call](#recipe-3--polling-the-active-call)
9. [Recipe 4 — Rendering a call inside the conversation thread](#recipe-4--rendering-a-call-inside-the-conversation-thread)
10. [Recipe 5 — Inbound calls (no UI trigger needed)](#recipe-5--inbound-calls-no-ui-trigger-needed)
11. [Recipe 6 — Usage widget](#recipe-6--usage-widget)
12. [Recipe 7 — Admin: phone numbers](#recipe-7--admin-phone-numbers)
13. [Recipe 8 — Admin: configuration](#recipe-8--admin-configuration)
14. [Recipe 9 — Admin: webhook logs](#recipe-9--admin-webhook-logs)
15. [Error handling](#error-handling)
16. [Empty states, loading states, error states](#empty-states-loading-states-error-states)
17. [Edge cases checklist](#edge-cases-checklist)
18. [Performance notes](#performance-notes)

---

## What you're building

The agent's UX has **three surfaces**:

1. **Lead profile / conversation thread.** A "Call" button at the top, and call entries (in & out, completed & missed) interleaved with messages in the thread. This is 90% of the work.
2. **Usage widget.** Optional but recommended — small "X / Y minutes used this month" indicator somewhere in the sidebar/header.
3. **Admin pages.** Phone number management, calling settings, webhook logs.

The agent does **not** make calls in the browser. The browser sends one HTTP request — the agent's actual phone (their personal phone, configured by admin) starts ringing. The browser then watches for state changes and renders them.

```
┌──────────────────────────────────────────────────────────────┐
│  Lead profile page                                            │
│                                                               │
│  ┌─────────────────────────────────────────────┐             │
│  │  Jane Smith  +1 (415) 555-5678              │  [📞 Call] │
│  └─────────────────────────────────────────────┘             │
│                                                               │
│  Conversation thread:                                         │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  ☎  Outbound call · 3m 5s · 2 hours ago                 │ │
│  │  💬 "Hey, just confirming our 3pm tomorrow"             │ │
│  │  ☎  Inbound call · MISSED · yesterday                   │ │
│  │  💬 [auto-SMS] "Currently in an appointment..."         │ │
│  │  💬 "Sorry, will call back at 4pm"                      │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

---

## Setup

### Base URL

```
https://api.warmchats.com    # production
http://localhost:3000        # local dev
```

All calling API paths are under `/api`. Webhooks are not your problem — Telnyx hits the backend directly.

### Authentication

Every request needs:

```
Authorization: Bearer <jwt>
```

The JWT is whatever the rest of WarmChats already issues. If your existing app already has an auth context with the token, reuse it.

### CORS

The backend allows credentials and the `Authorization` header. You're fine.

---

## TypeScript types — copy these

Drop these in `src/types/calling.ts`. They match the backend exactly.

```ts
// ──────────────── Enums ────────────────

export type CallDirection = "INBOUND" | "OUTBOUND";

export type CallStatus =
  | "INITIATED" // record created, not yet sent to Telnyx
  | "RINGING" // agent's phone is ringing (or customer's, post-bridge)
  | "IN_PROGRESS" // both legs connected
  | "COMPLETED" // hung up normally, duration > 0
  | "NO_ANSWER" // ring timeout exhausted
  | "BUSY" // recipient was on another call
  | "FAILED" // network/carrier error
  | "CANCELED"; // hung up before answer

export type CallEventType =
  | "CALL_INITIATED"
  | "AGENT_RINGING"
  | "CUSTOMER_RINGING"
  | "AGENT_ANSWERED"
  | "CUSTOMER_ANSWERED"
  | "CALL_CONNECTED"
  | "CALL_COMPLETED"
  | "CALL_FAILED"
  | "CALL_NO_ANSWER"
  | "CALL_BUSY"
  | "CALL_CANCELED"
  | "MISSED_CALL_SMS_SENT";

export type PhoneNumberStatus =
  | "PROVISIONING"
  | "ACTIVE"
  | "SUSPENDED"
  | "RELEASED";

export type WebhookStatus =
  | "RECEIVED"
  | "PROCESSING"
  | "PROCESSED"
  | "FAILED"
  | "RETRYING";

// ──────────────── Resources ────────────────

export interface CallSummary {
  id: string;
  direction: CallDirection;
  status: CallStatus;
  duration: number; // seconds. 0 if not connected.
  initiatedAt: string; // ISO 8601
  answeredAt?: string;
  completedAt?: string;
  fromNumber: string;
  toNumber: string;
  agent: { id: string; name: string; email: string };
  businessNumber: { id: string; phoneNumber: string };
}

export interface CallEvent {
  id: string;
  eventType: CallEventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface CallDetails extends CallSummary {
  providerCallSid: string;
  customerNumber: string;
  agentPhoneNumber: string;
  lead: { id: string; name?: string; phoneNumber: string };
  callEvents: CallEvent[];
  errorMessage?: string;
}

export interface PhoneNumber {
  id: string;
  phoneNumber: string; // E.164: '+14155559999'
  provider: "telnyx";
  providerSid: string;
  status: PhoneNumberStatus;
  capabilities: { voice: boolean; sms: boolean };
  assignedToUser?: { id: string; name: string; email: string };
  createdAt: string;
}

export interface CallingConfiguration {
  id: string;
  workspaceId: string;
  provider: "telnyx";
  ringTimeout: number; // 20–30 (validated server-side)
  missedCallSmsTemplate: string;
  callingEnabled: boolean;
  recordingEnabled: boolean;
  autoChargeOverage: boolean;
}

export interface BillingCycle {
  id: string;
  startDate: string;
  endDate: string;
  planLimit: number; // minutes
}

export interface WorkspaceUsage {
  billingCycle: BillingCycle;
  usage: {
    totalMinutes: number;
    totalCost: number;
    totalCalls: number;
    percentageUsed: number;
    remainingMinutes: number;
    isOverLimit: boolean;
  };
  breakdown: {
    byStatus: Record<string, number>;
  };
}

export interface DashboardStats {
  totalCalls: number;
  byDirection: { INBOUND: number; OUTBOUND: number };
  byStatus: Array<{ status: CallStatus; count: number; avgDuration: number }>;
  avgDuration: number;
  answerRate: number;
  topAgents: Array<{ agentId: string; callCount: number }>;
}

export interface CanCallResponse {
  canCall: boolean;
  reasons: string[];
}

export interface WebhookLog {
  id: string;
  providerEventId: string;
  provider: "telnyx";
  eventType: string;
  status: WebhookStatus;
  retryCount: number;
  lastRetryAt?: string;
  processedAt?: string;
  errorMessage?: string;
  callId?: string;
  workspaceId?: string;
  receivedAt: string;
}

// ──────────────── Pagination ────────────────

export interface Paginated<T> {
  total: number;
  limit: number;
  offset: number;
  // The list field name varies per endpoint — see the API client.
}

// ──────────────── Errors ────────────────

export interface ApiError {
  statusCode: number;
  message: string;
  error: string;
}
```

---

## API client — copy this

A minimal type-safe wrapper. Drop in `src/api/calling.ts`.

```ts
import type {
  CallDetails,
  CallSummary,
  CallingConfiguration,
  CanCallResponse,
  DashboardStats,
  PhoneNumber,
  WebhookLog,
  WorkspaceUsage,
  ApiError,
} from "../types/calling";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

class CallingApiError extends Error {
  constructor(
    public status: number,
    public body: ApiError,
  ) {
    super(body?.message ?? `Request failed (${status})`);
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { token: string },
): Promise<T> {
  const { token, ...rest } = init;
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...rest.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({
      statusCode: res.status,
      message: res.statusText,
      error: "Unknown",
    }));
    throw new CallingApiError(res.status, body);
  }

  // 204 No Content
  if (res.status === 204) return undefined as T;

  return res.json() as Promise<T>;
}

// ──────────────── Agent endpoints ────────────────

export const calling = {
  canCall: (token: string) =>
    request<CanCallResponse>("/api/calling/can-call", { token }),

  initiateOutbound: (
    token: string,
    leadId: string,
    metadata?: Record<string, unknown>,
  ) =>
    request<{ callId: string; status: "INITIATED" }>(
      "/api/calling/calls/outbound",
      {
        token,
        method: "POST",
        body: JSON.stringify({ leadId, metadata }),
      },
    ),

  getCall: (token: string, callId: string) =>
    request<CallDetails>(`/api/calling/calls/${callId}`, { token }),

  getCallsByLead: (token: string, leadId: string, limit = 50, offset = 0) =>
    request<{
      calls: CallSummary[];
      total: number;
      limit: number;
      offset: number;
    }>(`/api/calling/leads/${leadId}/calls?limit=${limit}&offset=${offset}`, {
      token,
    }),

  getWorkspaceUsage: (token: string, billingCycleId?: string) => {
    const qs = billingCycleId ? `?billingCycleId=${billingCycleId}` : "";
    return request<WorkspaceUsage>(`/api/calling/usage/workspace${qs}`, {
      token,
    });
  },

  getDashboard: (token: string, startDate?: string, endDate?: string) => {
    const params = new URLSearchParams();
    if (startDate) params.set("startDate", startDate);
    if (endDate) params.set("endDate", endDate);
    const qs = params.toString();
    return request<DashboardStats>(
      `/api/calling/analytics/dashboard${qs ? `?${qs}` : ""}`,
      { token },
    );
  },
};

// ──────────────── Admin endpoints ────────────────

export const callingAdmin = {
  // Phone numbers
  listNumbers: (token: string, includeReleased = false) =>
    request<PhoneNumber[]>(
      `/api/admin/calling/phone-numbers?includeReleased=${includeReleased}`,
      { token },
    ),

  provisionNumber: (token: string, areaCode?: string, country = "US") =>
    request<{ phoneNumberId: string; message: string }>(
      "/api/admin/calling/phone-numbers",
      {
        token,
        method: "POST",
        body: JSON.stringify({ areaCode, country }),
      },
    ),

  assignNumber: (token: string, phoneNumberId: string, userId: string) =>
    request<{ phoneNumberId: string; userId: string; message: string }>(
      `/api/admin/calling/phone-numbers/${phoneNumberId}/assign`,
      { token, method: "PUT", body: JSON.stringify({ phoneNumberId, userId }) },
    ),

  releaseNumber: (token: string, phoneNumberId: string, reason?: string) => {
    const qs = reason ? `?reason=${encodeURIComponent(reason)}` : "";
    return request<{ phoneNumberId: string; message: string }>(
      `/api/admin/calling/phone-numbers/${phoneNumberId}${qs}`,
      { token, method: "DELETE" },
    );
  },

  // Configuration
  getConfig: (token: string) =>
    request<CallingConfiguration>("/api/admin/calling/configuration", {
      token,
    }),

  updateConfig: (
    token: string,
    updates: Partial<
      Pick<
        CallingConfiguration,
        | "ringTimeout"
        | "missedCallSmsTemplate"
        | "callingEnabled"
        | "recordingEnabled"
        | "autoChargeOverage"
        | "provider"
      >
    >,
  ) =>
    request<CallingConfiguration & { message: string }>(
      "/api/admin/calling/configuration",
      {
        token,
        method: "PUT",
        body: JSON.stringify(updates),
      },
    ),

  // Usage limits
  updateLimits: (token: string, planMinuteLimit: number, overageRate: number) =>
    request<{
      billingCycleId: string;
      planMinuteLimit: number;
      overageRate: number;
      message: string;
    }>("/api/admin/calling/usage/limits", {
      token,
      method: "PUT",
      body: JSON.stringify({ planMinuteLimit, overageRate }),
    }),

  getBreakdown: (
    token: string,
    billingCycleId: string,
    groupBy: "agent" | "day" | "status",
  ) =>
    request<{ billingCycleId: string; groupBy: string; breakdown: any[] }>(
      `/api/admin/calling/usage/breakdown?billingCycleId=${billingCycleId}&groupBy=${groupBy}`,
      { token },
    ),

  // Webhook logs
  getWebhookLogs: (token: string, status?: string, limit = 50, offset = 0) => {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    if (status) params.set("status", status);
    return request<{
      total: number;
      limit: number;
      offset: number;
      logs: WebhookLog[];
    }>(`/api/admin/calling/webhooks/logs?${params}`, { token });
  },

  retryWebhook: (token: string, webhookLogId: string) =>
    request<{ webhookLogId: string; message: string }>(
      `/api/admin/calling/webhooks/${webhookLogId}/retry`,
      { token, method: "POST" },
    ),
};

export { CallingApiError };
```

That's the complete client surface. ~150 lines, fully typed, no third-party HTTP library required.

---

## The call state machine

Every outbound call walks this graph:

```
                    ┌─────────────┐
                    │  INITIATED  │  ← row created, before Telnyx ack
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │   RINGING   │  ← agent's phone is ringing
                    └──────┬──────┘
                           │
                ┌──────────┴────────────┐
                │                       │
                ▼                       ▼
        ┌─────────────┐         ┌─────────────┐
        │ IN_PROGRESS │         │  NO_ANSWER  │  ← agent didn't pick up
        │             │         └─────────────┘     (terminal)
        │ ← bridged.  │
        │   Customer  │         ┌─────────────┐
        │   is also   │   ─►    │   FAILED    │  ← network / Telnyx error
        │   ringing,  │         └─────────────┘     (terminal)
        │   then on   │
        │   the call  │         ┌─────────────┐
        └──────┬──────┘   ─►    │  CANCELED   │  ← hung up pre-answer
               │                └─────────────┘     (terminal)
               ▼
        ┌─────────────┐         ┌─────────────┐
        │  COMPLETED  │   or    │    BUSY     │  ← customer was busy
        └─────────────┘         └─────────────┘
        (terminal)              (terminal)
```

Inbound calls follow the same shape: `INITIATED → RINGING → IN_PROGRESS → COMPLETED` happy path; `NO_ANSWER`/`BUSY`/`FAILED` triggers the missed-call SMS auto-reply.

**Terminal statuses** (where you should stop polling):

```ts
const TERMINAL_STATUSES: CallStatus[] = [
  "COMPLETED",
  "NO_ANSWER",
  "BUSY",
  "FAILED",
  "CANCELED",
];

export const isCallTerminal = (status: CallStatus) =>
  TERMINAL_STATUSES.includes(status);
```

---

## Recipe 1 — Lead profile: Call button + history

The Call button is **disabled** unless `canCall === true`. The reasons array tells you why so you can show a helpful tooltip.

```tsx
// hooks/useCanCall.ts
import { useEffect, useState } from "react";
import { calling } from "@/api/calling";
import type { CanCallResponse } from "@/types/calling";

export function useCanCall(token: string) {
  const [state, setState] = useState<CanCallResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    calling
      .canCall(token)
      .then((r) => !cancelled && setState(r))
      .catch(
        () =>
          !cancelled &&
          setState({ canCall: false, reasons: ["Failed to check"] }),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [token]);

  return { ...state, loading };
}
```

```tsx
// components/CallButton.tsx
import { useCanCall } from "@/hooks/useCanCall";

export function CallButton({
  token,
  onClick,
}: {
  token: string;
  onClick: () => void;
}) {
  const { canCall, reasons, loading } = useCanCall(token);

  if (loading) return <button disabled>…</button>;

  return (
    <button
      onClick={onClick}
      disabled={!canCall}
      title={canCall ? "" : reasons.join(" · ")}
      className={canCall ? "btn-primary" : "btn-disabled"}
    >
      📞 Call
    </button>
  );
}
```

When **should you re-fetch** `canCall`?

- On lead profile mount.
- After the admin updates calling configuration (the agent might just have been disabled).
- After a call ends — usage may have just crossed the plan limit _and_ the workspace might have `autoChargeOverage = false`.

You don't need to re-fetch every render. Once-on-mount + on significant events is fine.

---

## Recipe 2 — Placing an outbound call

Three states the UI moves through: `idle → placing → active → idle`.

```tsx
// hooks/usePlaceCall.ts
import { useState, useCallback } from "react";
import { calling, CallingApiError } from "@/api/calling";

export type CallSession =
  | { phase: "idle" }
  | { phase: "placing"; leadId: string }
  | { phase: "active"; leadId: string; callId: string }
  | { phase: "error"; leadId: string; message: string };

export function usePlaceCall(token: string) {
  const [session, setSession] = useState<CallSession>({ phase: "idle" });

  const place = useCallback(
    async (leadId: string) => {
      setSession({ phase: "placing", leadId });
      try {
        const { callId } = await calling.initiateOutbound(token, leadId);
        setSession({ phase: "active", leadId, callId });
        return callId;
      } catch (e) {
        const msg =
          e instanceof CallingApiError
            ? e.body.message
            : "Could not place the call. Try again.";
        setSession({ phase: "error", leadId, message: msg });
        throw e;
      }
    },
    [token],
  );

  const reset = useCallback(() => setSession({ phase: "idle" }), []);

  return { session, place, reset };
}
```

UI binding:

```tsx
function LeadProfile({ leadId, token }: { leadId: string; token: string }) {
  const { session, place, reset } = usePlaceCall(token);

  return (
    <>
      <CallButton token={token} onClick={() => place(leadId)} />

      {session.phase === "placing" && (
        <Banner>📞 Calling your phone — pick up to connect to the lead.</Banner>
      )}

      {session.phase === "active" && (
        <ActiveCallBanner callId={session.callId} token={token} onEnd={reset} />
      )}

      {session.phase === "error" && (
        <Banner variant="error" onDismiss={reset}>
          {session.message}
        </Banner>
      )}
    </>
  );
}
```

> **Important UX point:** the agent's real phone starts ringing roughly 1–3 seconds after the `POST /outbound` returns. Tell the agent in plain words: _"We're calling your phone now — pick up to connect to the lead."_ Don't show a "Connect" button in the UI — there's nothing to connect; it's a phone-to-phone call.

---

## Recipe 3 — Polling the active call

While the call is in flight, poll `GET /api/calling/calls/:callId` every 2-3 seconds and stop on a terminal status.

```tsx
// hooks/useActiveCall.ts
import { useEffect, useState } from "react";
import { calling } from "@/api/calling";
import type { CallDetails, CallStatus } from "@/types/calling";

const POLL_INTERVAL_MS = 2500;
const TERMINAL: CallStatus[] = [
  "COMPLETED",
  "NO_ANSWER",
  "BUSY",
  "FAILED",
  "CANCELED",
];

export function useActiveCall(token: string, callId: string | null) {
  const [call, setCall] = useState<CallDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!callId) {
      setCall(null);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const data = await calling.getCall(token, callId);
        if (cancelled) return;
        setCall(data);
        if (TERMINAL.includes(data.status)) return; // stop polling
        timer = setTimeout(tick, POLL_INTERVAL_MS);
      } catch (e: any) {
        if (cancelled) return;
        setError(e.message);
        // Back off and retry on transient errors
        timer = setTimeout(tick, POLL_INTERVAL_MS * 2);
      }
    };

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [token, callId]);

  return { call, error };
}
```

```tsx
// components/ActiveCallBanner.tsx
import { useActiveCall } from "@/hooks/useActiveCall";

const labels: Record<string, string> = {
  INITIATED: "Setting up the call…",
  RINGING: "☎ Your phone is ringing",
  IN_PROGRESS: "🔊 On the call",
  COMPLETED: "✓ Call ended",
  NO_ANSWER: "✗ No answer",
  BUSY: "✗ Busy",
  FAILED: "✗ Call failed",
  CANCELED: "✗ Call canceled",
};

export function ActiveCallBanner({
  callId,
  token,
  onEnd,
}: {
  callId: string;
  token: string;
  onEnd: () => void;
}) {
  const { call } = useActiveCall(token, callId);

  if (!call) return <Banner>Connecting…</Banner>;

  const isTerminal = [
    "COMPLETED",
    "NO_ANSWER",
    "BUSY",
    "FAILED",
    "CANCELED",
  ].includes(call.status);

  return (
    <Banner variant={isTerminal ? "neutral" : "active"}>
      {labels[call.status]}
      {call.status === "IN_PROGRESS" && call.answeredAt && (
        <span>
          {" "}
          · <Duration since={call.answeredAt} />
        </span>
      )}
      {call.status === "COMPLETED" && (
        <span>
          {" "}
          · {Math.round(call.duration / 60)}m {call.duration % 60}s
        </span>
      )}
      {isTerminal && <button onClick={onEnd}>Dismiss</button>}
    </Banner>
  );
}
```

`<Duration since={iso} />` is a 5-line component that ticks once a second to render `1m 23s`. Trivial — left as an exercise.

---

## Recipe 4 — Rendering a call inside the conversation thread

Every call is a row in the lead's call list. You probably already have a thread component that renders messages by timestamp. Mix calls into that same stream.

```tsx
// hooks/useLeadCalls.ts
import { useEffect, useState, useCallback } from "react";
import { calling } from "@/api/calling";
import type { CallSummary } from "@/types/calling";

export function useLeadCalls(token: string, leadId: string) {
  const [calls, setCalls] = useState<CallSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const { calls } = await calling.getCallsByLead(token, leadId);
    setCalls(calls);
    setLoading(false);
  }, [token, leadId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { calls, loading, refresh };
}
```

To merge messages and calls in time order:

```tsx
type ThreadItem =
  | { kind: "message"; id: string; createdAt: string; data: Message }
  | { kind: "call"; id: string; createdAt: string; data: CallSummary };

function buildThread(messages: Message[], calls: CallSummary[]): ThreadItem[] {
  const items: ThreadItem[] = [
    ...messages.map((m) => ({
      kind: "message" as const,
      id: m.id,
      createdAt: m.createdAt,
      data: m,
    })),
    ...calls.map((c) => ({
      kind: "call" as const,
      id: c.id,
      createdAt: c.initiatedAt,
      data: c,
    })),
  ];
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
```

The call row component:

```tsx
function CallRow({ call }: { call: CallSummary }) {
  const isInbound = call.direction === "INBOUND";
  const wasAnswered = call.status === "COMPLETED";
  const wasMissed = ["NO_ANSWER", "BUSY", "FAILED"].includes(call.status);

  return (
    <div className={`call-row ${isInbound ? "inbound" : "outbound"}`}>
      <span className="icon">{isInbound ? "↘" : "↗"}</span>
      <span className="label">
        {isInbound ? "Inbound call" : "Outbound call"}
        {wasAnswered && ` · ${formatDuration(call.duration)}`}
        {wasMissed && " · Missed"}
        {call.status === "CANCELED" && " · Canceled"}
        {call.status === "FAILED" && " · Failed"}
      </span>
      <time>{relativeTime(call.initiatedAt)}</time>
      {call.status === "IN_PROGRESS" && <span className="live-dot" />}
    </div>
  );
}

const formatDuration = (s: number) =>
  s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
```

### When does the thread refresh?

Three triggers:

1. On mount.
2. **After an outbound call ends** — call `refresh()` from your `useLeadCalls` hook when `useActiveCall` reports a terminal status.
3. **Periodically while the user is on the lead profile** — every 30s is plenty. This catches inbound missed calls and the auto-SMS that follows.

```tsx
useEffect(() => {
  const id = setInterval(refresh, 30_000);
  return () => clearInterval(id);
}, [refresh]);
```

If you have WebSockets in the rest of the app, push a `lead.${leadId}.calls.changed` event from the backend and skip the polling. Until then, 30s polling is fine.

---

## Recipe 5 — Inbound calls (no UI trigger needed)

When a customer dials the business number:

1. Their phone rings the agent's real phone for 25s.
2. The backend creates a `Call` row with `direction = INBOUND`.
3. If the agent doesn't pick up, the backend sends the auto-SMS to the customer, recording it as a `MISSED_CALL_SMS_SENT` event on the call.

The frontend has nothing to do during this except keep refreshing the lead's call list (Recipe 4 covers it). The next refresh will surface the new inbound call entry.

If you want to surface a "📞 Inbound call right now" indicator while the agent's phone is ringing:

- Poll `getCallsByLead` more aggressively (every 5–10s) when the lead profile is open, OR
- Poll `getDashboard` and look for any call with `status === 'RINGING'`, OR
- Wait for WebSockets — that's the right way.

For a v1 launch, just refresh-on-30s is enough. The agent's actual phone will ring; they don't need a browser notification too.

---

## Recipe 6 — Usage widget

Small chip somewhere in the chrome:

```tsx
function UsageChip({ token }: { token: string }) {
  const [usage, setUsage] = useState<WorkspaceUsage | null>(null);

  useEffect(() => {
    calling.getWorkspaceUsage(token).then(setUsage);
  }, [token]);

  if (!usage) return null;

  const { totalMinutes, percentageUsed, isOverLimit } = usage.usage;
  const planLimit = usage.billingCycle.planLimit;

  return (
    <div className={`usage-chip ${isOverLimit ? "over" : ""}`}>
      <strong>{Math.round(totalMinutes)}</strong> / {planLimit} min
      <div className="bar">
        <div
          className="fill"
          style={{ width: `${Math.min(percentageUsed, 100)}%` }}
        />
      </div>
      {isOverLimit && <span className="badge">Overage</span>}
    </div>
  );
}
```

Refresh on mount + after a call ends. Don't hammer it.

---

## Recipe 7 — Admin: phone numbers

```tsx
function PhoneNumbersAdmin({ token }: { token: string }) {
  const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
  const refresh = () => callingAdmin.listNumbers(token).then(setNumbers);

  useEffect(() => {
    refresh();
  }, []);

  const buyNumber = async (areaCode: string) => {
    await callingAdmin.provisionNumber(token, areaCode);
    refresh();
  };

  const assign = async (phoneNumberId: string, userId: string) => {
    try {
      await callingAdmin.assignNumber(token, phoneNumberId, userId);
      refresh();
    } catch (e) {
      if (e instanceof CallingApiError && e.status === 409) {
        alert(`That user already has a number assigned.`);
      } else {
        throw e;
      }
    }
  };

  const release = async (phoneNumberId: string) => {
    if (!confirm("Release this number? This is permanent.")) return;
    await callingAdmin.releaseNumber(token, phoneNumberId, "manual release");
    refresh();
  };

  return (
    <table>
      <thead>
        <tr>
          <th>Number</th>
          <th>Status</th>
          <th>Assigned to</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {numbers.map((n) => (
          <tr key={n.id}>
            <td>{n.phoneNumber}</td>
            <td>{n.status}</td>
            <td>
              {n.assignedToUser ? (
                `${n.assignedToUser.name} (${n.assignedToUser.email})`
              ) : (
                <AssignButton onAssign={(uid) => assign(n.id, uid)} />
              )}
            </td>
            <td>
              <button onClick={() => release(n.id)}>Release</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

Validation note: `areaCode` should be 3 digits. The backend will return `400` if no numbers are available in that area code — surface that to the admin so they can try a different code.

---

## Recipe 8 — Admin: configuration

```tsx
function ConfigAdmin({ token }: { token: string }) {
  const [config, setConfig] = useState<CallingConfiguration | null>(null);
  const [draft, setDraft] = useState<Partial<CallingConfiguration>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    callingAdmin.getConfig(token).then(setConfig);
  }, []);

  if (!config) return <p>Loading…</p>;

  const save = async () => {
    setSaving(true);
    try {
      const updated = await callingAdmin.updateConfig(token, draft);
      setConfig(updated);
      setDraft({});
    } catch (e) {
      if (e instanceof CallingApiError && e.status === 400) {
        alert(e.body.message); // e.g. "ringTimeout must not be greater than 30"
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label>
        Ring timeout (seconds, 20–30)
        <input
          type="number"
          min={20}
          max={30}
          defaultValue={config.ringTimeout}
          onChange={(e) =>
            setDraft({ ...draft, ringTimeout: Number(e.target.value) })
          }
        />
      </label>

      <label>
        Missed-call SMS template
        <textarea
          defaultValue={config.missedCallSmsTemplate}
          onChange={(e) =>
            setDraft({ ...draft, missedCallSmsTemplate: e.target.value })
          }
        />
      </label>

      <label>
        <input
          type="checkbox"
          defaultChecked={config.autoChargeOverage}
          onChange={(e) =>
            setDraft({ ...draft, autoChargeOverage: e.target.checked })
          }
        />
        Auto-charge overage (if off, calls are blocked at the plan limit)
      </label>

      <label>
        <input
          type="checkbox"
          defaultChecked={config.callingEnabled}
          onChange={(e) =>
            setDraft({ ...draft, callingEnabled: e.target.checked })
          }
        />
        Calling enabled
      </label>

      <button disabled={saving || Object.keys(draft).length === 0}>
        {saving ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
```

**Front-end validation rules** (mirror these client-side for fast feedback — the backend enforces them too):

| Field                   | Rule                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `ringTimeout`           | integer, 20 ≤ x ≤ 30                                                                                   |
| `missedCallSmsTemplate` | non-empty string. Don't go past 160 chars unless you've cleared multipart SMS billing with the client. |
| `provider`              | only `"telnyx"` is accepted                                                                            |
| `planMinuteLimit`       | integer ≥ 0                                                                                            |
| `overageRate`           | number ≥ 0 (dollars per minute)                                                                        |

---

## Recipe 9 — Admin: webhook logs

```tsx
function WebhookLogsAdmin({ token }: { token: string }) {
  const [logs, setLogs] = useState<WebhookLog[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("");

  const load = async () => {
    const { logs } = await callingAdmin.getWebhookLogs(
      token,
      statusFilter || undefined,
    );
    setLogs(logs);
  };

  useEffect(() => {
    load();
  }, [statusFilter]);

  const retry = async (id: string) => {
    await callingAdmin.retryWebhook(token, id);
    setTimeout(load, 1500);
  };

  return (
    <>
      <select
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value)}
      >
        <option value="">All</option>
        <option value="FAILED">Failed</option>
        <option value="RETRYING">Retrying</option>
        <option value="PROCESSED">Processed</option>
      </select>

      <table>
        <thead>
          <tr>
            <th>Event</th>
            <th>Status</th>
            <th>Retries</th>
            <th>Received</th>
            <th>Error</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {logs.map((l) => (
            <tr key={l.id} className={`status-${l.status}`}>
              <td>{l.eventType}</td>
              <td>{l.status}</td>
              <td>{l.retryCount}</td>
              <td>
                <time>{l.receivedAt}</time>
              </td>
              <td>{l.errorMessage ?? ""}</td>
              <td>
                {(l.status === "FAILED" || l.status === "RETRYING") && (
                  <button onClick={() => retry(l.id)}>Retry</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
```

---

## Error handling

The API returns errors in this shape (NestJS standard):

```ts
{ "statusCode": 403, "message": "Cannot make call: User does not have an assigned business number", "error": "Forbidden" }
```

Handle these per-status:

| Status | What it means                                                                                    | UX                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `400`  | Bad input — usually a validation failure or "Lead not found"                                     | Show the message inline near the form / on the action                                     |
| `401`  | Token missing or expired                                                                         | Redirect to login, refresh token, or show "Sign in again"                                 |
| `403`  | Action not permitted (no business number, calling disabled, plan exceeded with autoCharge=false) | Banner: surface the full message; on the Call button, this is also surfaced via `canCall` |
| `404`  | Resource not found (call, lead, billing cycle, webhook log)                                      | "This call was deleted" / "Couldn't find it"                                              |
| `409`  | Conflict (e.g., user already has a number)                                                       | "That agent already has a number — release theirs first"                                  |
| `5xx`  | Backend bug or downstream Telnyx outage                                                          | "Something went wrong on our end. Try again." + log to Sentry                             |

The `CallingApiError` class in the API client carries the full body, so you can branch on `e.body.message` for specific cases.

```ts
try {
  await calling.initiateOutbound(token, leadId);
} catch (e) {
  if (e instanceof CallingApiError) {
    if (e.status === 403) showBanner("error", e.body.message);
    else if (e.status === 400 && e.body.message.includes("Lead not found")) {
      showBanner("error", "This lead no longer exists. Refresh the page.");
    } else {
      showBanner("error", "Could not place the call.");
      reportToSentry(e);
    }
  }
}
```

---

## Empty states, loading states, error states

For each surface, you need to handle three:

### Lead profile call button

- **Loading** (`canCall === undefined`): show disabled button with `…` instead of the icon
- **Disabled** (`!canCall`): show with `title={reasons.join(' · ')}`
- **Failed network**: assume disabled, show "Couldn't check" tooltip

### Lead's call thread

- **Loading**: skeleton rows, NOT a spinner — preserves layout
- **Empty** (no calls yet): nothing — just don't render the section at all. Don't show "No calls yet" — it's noise
- **Error**: tiny inline retry button. Don't block the rest of the thread

### Active call banner

- **Placing** (post-POST, no callId yet): "Calling your phone…"
- **Active** (`status ∈ {INITIATED, RINGING, IN_PROGRESS}`): live banner with status label
- **Terminal** (`status ∈ {COMPLETED, NO_ANSWER, ...}`): show outcome briefly, then auto-dismiss after 5s — or require manual dismiss

### Usage chip

- **Loading**: hide it. Don't show a spinner here
- **Over limit**: highlight in red/orange, show the overage badge
- **Auto-charge off + over limit**: same plus a note "Calls are blocked"

---

## Edge cases checklist

Run through this list before shipping:

- [ ] **Agent navigates away during an active call.** Their phone is still on the call — the browser leaving doesn't matter. When they come back, fetch the lead's call list and show the most recent in-progress call as `IN_PROGRESS` until the next status update.
- [ ] **Two tabs open, agent clicks Call in tab 1.** Tab 2's call thread will pick up the new entry on its next 30s refresh. No special handling needed.
- [ ] **Agent's JWT expires mid-poll.** Catch `401`, kick to refresh-token flow, resume polling.
- [ ] **Network drops during polling.** The `useActiveCall` hook above retries on error. Don't show an error banner immediately — wait 2-3 failed ticks before flagging it.
- [ ] **Customer hangs up before agent picks up.** Status goes to `CANCELED`. Don't trigger missed-SMS UI on outbound — that's only for inbound (and the backend handles it anyway).
- [ ] **Outbound call where customer doesn't answer.** Status → `NO_ANSWER`. No SMS is sent (this is per-SOW: missed-SMS is inbound-only).
- [ ] **Inbound call to a number with no assigned agent.** Backend returns an error; the customer hears Telnyx's default treatment. You probably won't see this in the UI, but admins should be able to spot unassigned numbers in the phone-numbers admin.
- [ ] **`canCall` returns false because plan limit is hit and autoCharge is off.** The user sees a disabled button. They reach for an admin to flip the toggle. After flip, `canCall` should return true on next fetch.
- [ ] **Admin updates `ringTimeout`.** The change applies to **inbound** calls only (outbound timeout is handled server-side per call). No special FE action needed.
- [ ] **Admin assigns a number to a different agent.** The previous agent's `canCall` will start returning false. The next call attempt will fail with 403. Refresh `canCall` after admin actions.
- [ ] **Phone number formats.** All numbers are E.164: `+14155559999`. Display them with a formatter (`libphonenumber-js`'s `formatNational` is fine).
- [ ] **Timezone.** Every timestamp is ISO 8601 UTC. Render in the user's local timezone. Don't trust server time blindly.
- [ ] **Long-running call (>30 min).** Just keep polling. There's no special handling.
- [ ] **Workspace has zero billing cycles.** First time `getWorkspaceUsage` runs, the backend creates one for the current month. Don't need to special-case.

---

## Performance notes

### Polling cost

- During an active call: `GET /api/calling/calls/:callId` every 2.5s. Cheap — single row by primary key.
- Lead profile background: `GET /api/calling/leads/:leadId/calls` every 30s. Limit 50, indexed query. Fine for normal lead activity.
- Don't poll `getDashboard` or `getWorkspaceUsage` — those are heavier aggregations. Refetch on event triggers (call ended, page mount).

### Cache invalidation

If you're using SWR / React Query, key like:

```ts
["call", callId][("leadCalls", leadId)]["canCall"]["workspaceUsage"][
  "adminPhoneNumbers"
]["adminConfig"][("webhookLogs", statusFilter)];
```

Mutations should `invalidate(['leadCalls', leadId])` and `invalidate(['canCall'])` after a call ends.

### Bundle size

The whole API client + types is ~250 lines. No external HTTP library needed. Tree-shakes cleanly if you only import what you use.

---

## Quick start: a working lead-profile in ~50 lines

If you want to ship the minimum viable version _today_, here it is:

```tsx
import { useEffect, useState } from "react";
import { calling } from "@/api/calling";

export function LeadCallingSection({
  leadId,
  token,
}: {
  leadId: string;
  token: string;
}) {
  const [canCall, setCanCall] = useState(false);
  const [calls, setCalls] = useState<any[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeCall, setActiveCall] = useState<any>(null);

  // Initial loads
  useEffect(() => {
    calling.canCall(token).then((r) => setCanCall(r.canCall));
    calling.getCallsByLead(token, leadId).then((r) => setCalls(r.calls));
  }, [token, leadId]);

  // Periodic refresh
  useEffect(() => {
    const id = setInterval(() => {
      calling.getCallsByLead(token, leadId).then((r) => setCalls(r.calls));
    }, 30_000);
    return () => clearInterval(id);
  }, [token, leadId]);

  // Active-call polling
  useEffect(() => {
    if (!activeId) return;
    let alive = true;
    const tick = async () => {
      const c = await calling.getCall(token, activeId);
      if (!alive) return;
      setActiveCall(c);
      if (
        ["COMPLETED", "NO_ANSWER", "BUSY", "FAILED", "CANCELED"].includes(
          c.status,
        )
      ) {
        calling.getCallsByLead(token, leadId).then((r) => setCalls(r.calls));
        setActiveId(null);
      } else {
        setTimeout(tick, 2500);
      }
    };
    tick();
    return () => {
      alive = false;
    };
  }, [activeId, token, leadId]);

  const onCall = async () => {
    const { callId } = await calling.initiateOutbound(token, leadId);
    setActiveId(callId);
  };

  return (
    <section>
      <button disabled={!canCall || !!activeId} onClick={onCall}>
        📞 Call
      </button>

      {activeCall && (
        <div className="banner">
          {activeCall.status === "RINGING" && "☎ Ringing your phone…"}
          {activeCall.status === "IN_PROGRESS" && "🔊 On the call"}
          {activeCall.status === "COMPLETED" && `✓ ${activeCall.duration}s`}
          {activeCall.status === "NO_ANSWER" && "✗ No answer"}
        </div>
      )}

      <ul>
        {calls.map((c) => (
          <li key={c.id}>
            {c.direction === "INBOUND" ? "↘" : "↗"} {c.status} · {c.duration}s ·{" "}
            {c.initiatedAt}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

That's a working calling integration. Style it, add the message thread, polish the empty/error states from the checklist above — and you're done.
