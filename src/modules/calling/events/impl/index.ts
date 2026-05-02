import { IEvent } from '@nestjs/cqrs';

// ============================================
// CALL LIFECYCLE EVENTS
// ============================================

export class CallInitiatedEvent implements IEvent {
  constructor(
    public readonly callId: string,
    public readonly providerCallSid: string,
    public readonly direction: 'INBOUND' | 'OUTBOUND',
    public readonly agentId: string,
    public readonly leadId: string,
    public readonly workspaceId: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}

export class InboundCallReceivedEvent implements IEvent {
  constructor(
    public readonly callId: string,
    public readonly providerCallSid: string,
    public readonly fromNumber: string,
    public readonly toNumber: string,
    public readonly agentId: string,
    public readonly leadId: string,
    public readonly workspaceId: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}

export class AgentAnsweredEvent implements IEvent {
  constructor(
    public readonly callId: string,
    public readonly providerCallSid: string,
    public readonly agentId: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}

export class CustomerAnsweredEvent implements IEvent {
  constructor(
    public readonly callId: string,
    public readonly providerCallSid: string,
    public readonly leadId: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}

export class CallConnectedEvent implements IEvent {
  constructor(
    public readonly callId: string,
    public readonly providerCallSid: string,
    public readonly agentId: string,
    public readonly leadId: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}

export class CallCompletedEvent implements IEvent {
  constructor(
    public readonly callId: string,
    public readonly providerCallSid: string,
    public readonly status: string,
    public readonly duration: number,
    public readonly agentId: string,
    public readonly leadId: string,
    public readonly workspaceId: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}

export class MissedCallEvent implements IEvent {
  constructor(
    public readonly callId: string,
    public readonly customerNumber: string,
    public readonly businessNumber: string,
    public readonly workspaceId: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}

// ============================================
// PHONE NUMBER EVENTS
// ============================================

export class PhoneNumberProvisionedEvent implements IEvent {
  constructor(
    public readonly phoneNumberId: string,
    public readonly phoneNumber: string,
    public readonly workspaceId: string,
    public readonly provider: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}

export class PhoneNumberAssignedEvent implements IEvent {
  constructor(
    public readonly phoneNumberId: string,
    public readonly phoneNumber: string,
    public readonly userId: string,
    public readonly workspaceId: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}

export class PhoneNumberReleasedEvent implements IEvent {
  constructor(
    public readonly phoneNumberId: string,
    public readonly phoneNumber: string,
    public readonly workspaceId: string,
    public readonly reason?: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}

// ============================================
// USAGE EVENTS
// ============================================

export class UsageLimitExceededEvent implements IEvent {
  constructor(
    public readonly workspaceId: string,
    public readonly billingCycleId: string,
    public readonly currentMinutes: number,
    public readonly limitMinutes: number,
    public readonly timestamp: Date = new Date(),
  ) {}
}

export class UsageRecordedEvent implements IEvent {
  constructor(
    public readonly usageRecordId: string,
    public readonly callId: string,
    public readonly workspaceId: string,
    public readonly agentId: string,
    public readonly minutes: number,
    public readonly cost: number,
    public readonly isOverage: boolean,
    public readonly timestamp: Date = new Date(),
  ) {}
}

// ============================================
// WEBHOOK EVENTS
// ============================================

export class WebhookReceivedEvent implements IEvent {
  constructor(
    public readonly provider: string,
    public readonly eventType: string,
    public readonly providerEventId: string,
    public readonly payload: any,
    public readonly timestamp: Date = new Date(),
  ) {}
}

export class WebhookProcessedEvent implements IEvent {
  constructor(
    public readonly webhookLogId: string,
    public readonly providerEventId: string,
    public readonly success: boolean,
    public readonly errorMessage?: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}
