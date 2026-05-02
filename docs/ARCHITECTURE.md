# WarmChats Calling Module - Architecture

## Overview

This module implements a production-grade calling system using **CQRS (Command Query Responsibility Segregation)** pattern with **Event Sourcing** principles in NestJS.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     Frontend (React/Next.js)                 │
│  - Call button UI                                            │
│  - Call logs display                                         │
│  - Usage dashboard                                           │
└──────────────────────┬──────────────────────────────────────┘
                       │ REST API
                       │
┌──────────────────────▼──────────────────────────────────────┐
│              NestJS API Layer (Controllers)                  │
│  - CallsController (REST endpoints)                          │
│  - TwilioWebhookController (Webhooks)                        │
│  - AdminController (Admin operations)                        │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                   CQRS Layer (NestJS CQRS)                   │
│                                                              │
│  ┌────────────────┐    ┌────────────────┐    ┌───────────┐ │
│  │   Commands     │    │    Queries     │    │  Events   │ │
│  │  (Write Ops)   │    │  (Read Ops)    │    │ (Domain)  │ │
│  └────────┬───────┘    └────────┬───────┘    └─────┬─────┘ │
│           │                     │                   │        │
│  ┌────────▼───────┐    ┌───────▼────────┐   ┌──────▼─────┐ │
│  │ Command        │    │ Query          │   │Event       │ │
│  │ Handlers       │    │ Handlers       │   │Handlers    │ │
│  │                │    │                │   │(Sagas)     │ │
│  └────────┬───────┘    └────────┬───────┘   └──────┬─────┘ │
└───────────┼─────────────────────┼───────────────────┼───────┘
            │                     │                   │
            │                     │                   │
┌───────────▼─────────────────────▼───────────────────▼───────┐
│                    Domain Services Layer                     │
│                                                              │
│  ┌─────────────────────────┐   ┌──────────────────────────┐ │
│  │ TelephonyService        │   │ UsageMeteringService     │ │
│  │ - Twilio Provider       │   │ - Track usage            │ │
│  │ - Telnyx Provider       │   │ - Enforce limits         │ │
│  │ - Abstraction layer     │   │ - Calculate overage      │ │
│  └─────────────────────────┘   └──────────────────────────┘ │
└───────────────────────┬──────────────────────────────────────┘
                        │
                        │
┌───────────────────────▼──────────────────────────────────────┐
│                  Data Access Layer (TypeORM)                 │
│                                                              │
│  ┌──────────────┐  ┌───────────┐  ┌─────────────┐  ┌─────┐ │
│  │PhoneAssign   │  │ CallLog   │  │UsageRecord  │  │Plan │ │
│  │ment          │  │           │  │             │  │Limit│ │
│  └──────────────┘  └───────────┘  └─────────────┘  └─────┘ │
└───────────────────────┬──────────────────────────────────────┘
                        │
                        ▼
                   PostgreSQL

┌──────────────────────────────────────────────────────────────┐
│                    External Services                         │
│                                                              │
│  ┌─────────────────────┐            ┌────────────────────┐  │
│  │  Twilio/Telnyx      │            │  BullMQ (Redis)    │  │
│  │  - Voice API        │            │  - Webhook retries │  │
│  │  - SMS API          │            │  - Async jobs      │  │
│  │  - Webhooks         │            │  - Job queues      │  │
│  └─────────────────────┘            └────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## CQRS Pattern Implementation

### Commands (Write Operations)

Commands represent **intentions to change state**. They are handled synchronously and enforce business rules.

**Example: InitiateOutboundCall**

```typescript
// 1. Command Definition
class InitiateOutboundCallCommand {
  constructor(
    public readonly agentId: string,
    public readonly leadId: string,
    public readonly customerPhoneNumber: string,
  ) {}
}

// 2. Command Handler
@CommandHandler(InitiateOutboundCallCommand)
class InitiateOutboundCallHandler {
  async execute(command) {
    // Business logic:
    // - Verify phone assignment
    // - Check plan limits
    // - Check usage
    // - Initiate call via provider
    // - Create call log
    // - Emit domain event
  }
}
```

**All Commands:**
- `InitiateOutboundCallCommand` - Start a call
- `ProcessInboundCallCommand` - Handle incoming call
- `UpdateCallStatusCommand` - Update call state
- `SendMissedCallSmsCommand` - Send missed call SMS

### Queries (Read Operations)

Queries **retrieve data** without side effects. They are optimized for reading.

**Example: GetCallLogs**

```typescript
// 1. Query Definition
class GetCallLogsQuery {
  constructor(public readonly params: GetCallLogsParams) {}
}

// 2. Query Handler
@QueryHandler(GetCallLogsQuery)
class GetCallLogsHandler {
  async execute(query) {
    // Read-optimized logic:
    // - Build efficient query
    // - Return data
  }
}
```

**All Queries:**
- `GetCallLogsQuery` - Fetch call history
- `GetUsageStatsQuery` - Fetch usage metrics

### Events (Domain Events)

Events represent **things that have happened**. They trigger side effects via Sagas.

**Example: CallMissed Event Flow**

```typescript
// 1. Event Definition
class CallMissedEvent {
  constructor(
    public readonly callLogId: string,
    public readonly customerNumber: string,
  ) {}
}

// 2. Event Published (in command handler)
this.eventBus.publish(new CallMissedEvent(...));

// 3. Event Handler (Saga)
@EventsHandler(CallMissedEvent)
class MissedCallSaga {
  async handle(event: CallMissedEvent) {
    // Trigger side effect:
    await this.commandBus.execute(
      new SendMissedCallSmsCommand(...),
    );
  }
}
```

**All Events:**
- `OutboundCallInitiatedEvent`
- `InboundCallReceivedEvent`
- `CallCompletedEvent`
- `CallMissedEvent`

## Request Flow Examples

### 1. Outbound Call Flow

```
User clicks "Call" button
  ↓
POST /api/v1/calling/calls
  ↓
CallsController.initiateCall()
  ↓
CommandBus.execute(InitiateOutboundCallCommand)
  ↓
InitiateOutboundCallHandler.execute()
  │
  ├─→ Verify PhoneAssignment (Repository)
  ├─→ Check PlanLimit (Repository)
  ├─→ Check UsageRecord (UsageMeteringService)
  ├─→ TelephonyService.initiateOutboundCall()
  │     └─→ Twilio/Telnyx API call
  ├─→ Create CallLog (Repository)
  └─→ EventBus.publish(OutboundCallInitiatedEvent)
  ↓
Return: { callLogId, providerCallSid, status }
```

### 2. Webhook Status Update Flow

```
Twilio/Telnyx sends webhook
  ↓
POST /api/v1/calling/webhooks/twilio/status
  ↓
TwilioWebhookController.handleStatusCallback()
  ↓
CommandBus.execute(UpdateCallStatusCommand)
  ↓
UpdateCallStatusHandler.execute()
  │
  ├─→ Find CallLog by providerCallSid
  ├─→ Update status, duration, endedAt
  ├─→ Save CallLog
  │
  ├─→ IF completed: UsageMeteringService.recordCallMinutes()
  │     └─→ Update UsageRecord
  │     └─→ EventBus.publish(CallCompletedEvent)
  │
  └─→ IF missed: EventBus.publish(CallMissedEvent)
        ↓
        MissedCallSaga.handle()
        ↓
        CommandBus.execute(SendMissedCallSmsCommand)
        ↓
        SendMissedCallSmsHandler.execute()
        ↓
        TelephonyService.sendSms()
        ↓
        Update CallLog.missedCallSmsSent = true
```

### 3. Query Flow

```
User opens call history
  ↓
GET /api/v1/calling/calls?leadId=xyz
  ↓
CallsController.getCallLogs()
  ↓
QueryBus.execute(GetCallLogsQuery)
  ↓
GetCallLogsHandler.execute()
  ↓
TypeORM QueryBuilder
  ↓
Return: CallLog[]
```

## Database Schema

### Entities & Relations

```
PhoneAssignment (1) ──────► (N) CallLog
    │                           │
    │                           │
    └──► Used for routing       └──► Aggregated into UsageRecord
         inbound calls

PlanLimit ──────► Defines limits for UsageRecord
```

### Indexes Strategy

```sql
-- High-volume read patterns
CREATE INDEX idx_call_logs_lead_created ON call_logs(lead_id, created_at DESC);
CREATE INDEX idx_call_logs_agent_created ON call_logs(agent_id, created_at DESC);

-- Webhook lookups (must be fast)
CREATE UNIQUE INDEX idx_call_logs_provider_sid ON call_logs(provider_call_sid);

-- Usage tracking
CREATE INDEX idx_usage_agent_cycle ON usage_records(agent_id, billing_cycle_start);
```

## Service Layer Architecture

### TelephonyService

**Provider Abstraction Pattern:**

```typescript
interface TelephonyProvider {
  initiateOutboundCall(params): Promise<InitiateCallResult>;
  sendSms(params): Promise<void>;
  generateInboundCallResponse(params): string | object;
}

class TwilioProvider implements TelephonyProvider { ... }
class TelnyxProvider implements TelephonyProvider { ... }

// Runtime selection based on env config
class TelephonyService {
  private provider: TelephonyProvider;
  
  constructor() {
    this.provider = config.provider === 'twilio' 
      ? new TwilioProvider() 
      : new TelnyxProvider();
  }
}
```

### UsageMeteringService

**Responsibilities:**
- Track minutes per billing cycle
- Enforce plan limits
- Calculate overage
- Block calls when limit exceeded (if configured)

**Usage Cycle:**

```
getCurrentUsage()
  ↓
Find or create UsageRecord for current billing cycle
  ↓
Check if over limit
  ↓
Return usage stats
```

## Error Handling Strategy

### Webhook Retry Pattern

```typescript
// In webhook controller
try {
  await this.commandBus.execute(updateCommand);
} catch (error) {
  // Enqueue retry job
  await this.webhookQueue.add('status-update', {
    ...data,
    attemptCount: 1,
  }, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000, // 2s, 4s, 8s
    },
  });
}
```

### Idempotency

**Problem:** Webhooks can be delivered multiple times.

**Solution:** Use `provider_call_sid` as idempotency key:

```typescript
// In UpdateCallStatusHandler
const callLog = await this.callLogRepository.findOne({
  where: { providerCallSid }, // UNIQUE constraint
});

if (callLog.status === 'completed') {
  return; // Already processed
}
```

## Testing Strategy

### Unit Tests
- Command handlers (with mocked repositories)
- Query handlers
- Service methods

### Integration Tests
- Full command → handler → repository flow
- Webhook processing

### E2E Tests
- API endpoints
- Complete call flows

## Scalability Considerations

### Horizontal Scaling

```
Load Balancer
  ├─→ App Instance 1
  ├─→ App Instance 2
  └─→ App Instance 3
      │
      └─→ Shared PostgreSQL
      └─→ Shared Redis (BullMQ)
```

### Performance Optimization

1. **Database Connection Pooling**
   ```typescript
   TypeOrmModule.forRoot({
     poolSize: 20,
   })
   ```

2. **Query Optimization**
   - Composite indexes on frequent queries
   - Pagination on call logs
   - Denormalized usage stats for dashboards

3. **Caching**
   - Cache PlanLimits (rarely change)
   - Cache PhoneAssignments (change infrequently)

## Monitoring & Observability

### Key Metrics to Track

1. **Call Metrics**
   - Calls initiated per minute
   - Call success rate
   - Average call duration

2. **Webhook Metrics**
   - Webhook latency
   - Webhook retry rate
   - Failed webhooks (DLQ)

3. **Usage Metrics**
   - Total minutes per day
   - Agents over 80% usage
   - Overage blocks

### Logging Strategy

```typescript
this.logger.log(`Call initiated: ${callSid}`, {
  agentId,
  leadId,
  provider: 'twilio',
});
```

## Security Best Practices

1. **Webhook Signature Validation**
   ```typescript
   const signature = req.headers['x-twilio-signature'];
   if (!twilio.validateRequest(authToken, signature, url, params)) {
     throw new UnauthorizedException('Invalid signature');
   }
   ```

2. **Rate Limiting**
   ```typescript
   @UseGuards(ThrottlerGuard)
   @Throttle(10, 60) // 10 calls per 60 seconds
   ```

3. **Phone Number Sanitization**
   ```typescript
   const sanitized = phoneNumber.replace(/[^\d+]/g, '');
   ```

## Deployment Architecture

```
                    ┌─────────────┐
                    │   Nginx     │
                    │ (SSL Term)  │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │ Load Balancer│
                    └──────┬──────┘
              ┌────────────┼────────────┐
              │            │            │
        ┌─────▼─────┐ ┌────▼────┐ ┌────▼────┐
        │  App 1    │ │ App 2   │ │  App 3  │
        │  (Docker) │ │(Docker) │ │(Docker) │
        └─────┬─────┘ └────┬────┘ └────┬────┘
              │            │            │
              └────────────┼────────────┘
                           │
              ┌────────────▼────────────┐
              │                         │
        ┌─────▼─────┐          ┌───────▼──────┐
        │PostgreSQL │          │    Redis     │
        │ (Primary) │          │  (Cluster)   │
        └───────────┘          └──────────────┘
```

## Future Enhancements

1. **Call Recording** - Store recording URLs
2. **Call Analytics** - Sentiment analysis, transcription
3. **Multi-tenant** - Workspace isolation
4. **Advanced Routing** - Skills-based routing
5. **WebRTC** - In-app calling (not just bridging)
